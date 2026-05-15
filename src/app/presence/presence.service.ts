import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import Redis from 'ioredis';
import { AgentPresenceRepository } from './repository/agent-presence.repository';
import { AgentPresenceEntity } from './entity/agent-presence.entity';
import {
  PRESENCE_ERRORS,
  PRESENCE_REJECT_TTL_SEC,
  presenceKeys,
} from './presence.constants';
import { REDIS_CLIENT } from '../../lib/cache/redis.module';
import { ConfigService } from '@nestjs/config';
import { GoOfflineResult } from './presence.service.types';
import { ShardedKnex } from '../../lib/sharding/shards';
import { OrderRepository } from '../order/repository/order.repository';

@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    private readonly presenceRepo: AgentPresenceRepository,
    private readonly orderRepo: OrderRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly configService: ConfigService,
  ) {}

  // ─── POST /agents/presence/online ─────────────────────────────────────────
  async goOnline(
    region: string,
    agentId: number,
    lat: number,
    lng: number,
  ): Promise<AgentPresenceEntity> {
    // 1. UPSERT Postgres
    const entity = await this.presenceRepo.upsertOnline(region, {
      agentId,
      region,
      lat,
      lng,
    });

    // 2. Write-through Redis
    const pipeline = this.redis.pipeline();
    pipeline.geoadd(presenceKeys.geo(region), lng, lat, String(agentId));
    pipeline.hmset(presenceKeys.meta(region, agentId), {
      last_seen_at: String(Date.now()),
      active_orders: '0',
      is_online: '1',
    });
    // Defensive: going online resets busy state
    pipeline.srem(presenceKeys.busy(region), String(agentId));
    await pipeline.exec();

    return entity;
  }

  // ─── POST /agents/presence/offline ────────────────────────────────────────
  async goOffline(
    region: string,
    agentId: number,
  ): Promise<GoOfflineResult> {
    // 1. Check active deliveries
    const activeOrders = await this.orderRepo.findActiveByAgent(region, agentId);

    for (const order of activeOrders) {
      if (order.status === 'picked') {
        throw new ConflictException(PRESENCE_ERRORS.ACTIVE_PICKUP_BLOCKS_OFFLINE);
      }
    }

    // 2. If agent has assigned orders, they'll be reassigned by the caller
    const assignedOrder = activeOrders.find((o) => o.status === 'assigned');

    // 3. Update Postgres
    await this.presenceRepo.updateOffline(region, agentId);

    // 4. Remove from Redis
    const pipeline = this.redis.pipeline();
    pipeline.zrem(presenceKeys.geo(region), String(agentId));
    pipeline.del(presenceKeys.meta(region, agentId));
    pipeline.srem(presenceKeys.busy(region), String(agentId));
    await pipeline.exec();

    if (assignedOrder) {
      return {
        ok: true,
        reassignOrderId: assignedOrder.id,
        reassignOrderCreatedAt: assignedOrder.createdAt,
        reassignOrderRegion: region,
      };
    }

    return { ok: true };
  }

  // ─── POST /agents/presence/ping ───────────────────────────────────────────
  async ping(
      region: string,
      agentId: number,
      lat: number,
      lng: number,
  ): Promise<AgentPresenceEntity> {
    const entity = await this.presenceRepo.updatePing(region, agentId, lat, lng);
    if (!entity) {
      throw new ConflictException(PRESENCE_ERRORS.NOT_ONLINE);
    }

    // Write-through Redis
    const pipeline = this.redis.pipeline();
    pipeline.geoadd(presenceKeys.geo(region), lng, lat, String(agentId));

    // 🔥 THE FIX: Make ping self-healing!
    pipeline.hmset(presenceKeys.meta(region, agentId), {
      last_seen_at: String(Date.now()),
      is_online: '1', // Ensure they stay online even if Redis forgot them
    });

    // We don't overwrite active_orders here because ping shouldn't reset their order count!

    await pipeline.exec();

    return entity;
  }
  // ─── Redis helpers used by AssignmentService ──────────────────────────────

  /**
  /**
   * GEOSEARCH for nearby online agents. Returns up to `k` candidates sorted
   * by distance ASC.
   */
  async findNearbyAgentsRedis(
    region: string,
    lng: number,
    lat: number,
    radiusMeters: number,
    k: number,
  ): Promise<Array<{ agentId: number; distance: number }>> {
    // GEOSEARCH key FROMLONLAT lng lat BYRADIUS r m ASC COUNT k WITHDIST
    const results: any = await this.redis.call(
      'GEOSEARCH',
      presenceKeys.geo(region),
      'FROMLONLAT',
      String(lng),
      String(lat),
      'BYRADIUS',
      String(radiusMeters),
      'm',
      'ASC',
      'COUNT',
      String(k),
      'WITHDIST',
    );

    if (!Array.isArray(results)) return [];

    return results.map((r: [string, string]) => ({
      agentId: Number(r[0]),
      distance: Number(r[1]),
    }));
  }

  /**
   * Fetch meta (last_seen_at, active_orders) for a batch of agent IDs.
   */
  async getAgentsMeta(
    region: string,
    agentIds: number[],
  ): Promise<
    Map<number, { lastSeenAt: number; activeOrders: number; isOnline: boolean }>
  > {
    const result = new Map<
      number,
      { lastSeenAt: number; activeOrders: number; isOnline: boolean }
    >();
    if (agentIds.length === 0) return result;

    const pipeline = this.redis.pipeline();
    for (const id of agentIds) {
      pipeline.hgetall(presenceKeys.meta(region, id));
    }
    const replies = await pipeline.exec();
    if (!replies) return result;

    for (let i = 0; i < agentIds.length; i++) {
      const [err, hash] = replies[i] as [Error | null, Record<string, string>];
      if (err || !hash || Object.keys(hash).length === 0) continue;
      result.set(agentIds[i], {
        lastSeenAt: Number(hash.last_seen_at ?? 0),
        activeOrders: Number(hash.active_orders ?? 0),
        isOnline: hash.is_online === '1',
      });
    }
    return result;
  }

  /**
   * Check if an agentId is in the reject set for the given orderId.
   */
  async isRejected(orderId: number, agentId: number): Promise<boolean> {
    const result = await this.redis.sismember(
      presenceKeys.reject(orderId),
      String(agentId),
    );
    return result === 1;
  }

  /**
   * Add an agent to the reject set for the given orderId.
   */
  async addRejection(orderId: number, agentId: number): Promise<void> {
    const key = presenceKeys.reject(orderId);
    await this.redis.sadd(key, String(agentId));
    await this.redis.expire(key, PRESENCE_REJECT_TTL_SEC);
  }

  /**
   * Increment/decrement active_orders on the agent's meta hash.
   * Also maintains the busy set.
   */
  async incrementActiveOrders(
    region: string,
    agentId: number,
    delta: number,
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(
      presenceKeys.meta(region, agentId),
      'active_orders',
      delta,
    );
    if (delta > 0) {
      pipeline.sadd(presenceKeys.busy(region), String(agentId));
    }
    await pipeline.exec();

    // If delta < 0, check if active_orders is now 0 → remove from busy
    if (delta < 0) {
      const val = await this.redis.hget(
        presenceKeys.meta(region, agentId),
        'active_orders',
      );
      if (Number(val ?? 0) <= 0) {
        await this.redis.srem(presenceKeys.busy(region), String(agentId));
      }
    }
  }

  /**
   * Lazily evict stale agents from Redis (called during assignment scan).
   */
  async evictStaleAgent(region: string, agentId: number): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.zrem(presenceKeys.geo(region), String(agentId));
    pipeline.del(presenceKeys.meta(region, agentId));
    pipeline.srem(presenceKeys.busy(region), String(agentId));
    await pipeline.exec();
    this.logger.warn(`Evicted stale agent ${agentId} from Redis (region=${region})`);
  }

  /**
   * Clean up the reject set for an orderId (after assignment succeeds or exhausts).
   */
  async clearRejectSet(orderId: number): Promise<void> {
    await this.redis.del(presenceKeys.reject(orderId));
  }
}
