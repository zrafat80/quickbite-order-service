import {
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
import { OrderRepository } from './repository/order.repository';
import { OrderEntity } from './entity/order.entity';
import { OrderStatus } from './enums';
import { PresenceService } from '../presence/presence.service';
import { AgentPresenceRepository } from '../presence/repository/agent-presence.repository';
import { AgentEarningRepository } from '../agent/repository/agent-earning.repository';
import { RestaurantBalanceRepository } from '../restaurant-finance/repository/restaurant-balance.repository';
import { TransactionRepository } from '../payment/repository/transaction.repository';
import { BranchClient } from '../../lib/core-client/branch.client';
import { WsPublisher } from '../../lib/websocket/ws.publisher';
import { ShardedKnex } from '../../lib/sharding/shards';
import { AssignmentCandidate, TryAssignResult } from './assignment.service.types';
import { DeliveryTaskResponseDTO } from '../agent/dto/agent.response.dto';
import {
  TransactionStatus,
  TransactionType,
  TransactionMethod,
} from '../payment/enums';
import {REDIS_CLIENT} from "../../lib/cache/redis.module";
import Redis from "ioredis";
import {presenceKeys} from "../presence/presence.constants";

@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly orderRepo: OrderRepository,
    private readonly presenceService: PresenceService,
    private readonly presenceRepo: AgentPresenceRepository,
    private readonly earningRepo: AgentEarningRepository,
    private readonly branchClient: BranchClient,
    private readonly wsPublisher: WsPublisher,
    private readonly configService: ConfigService,
    private readonly balanceRepo: RestaurantBalanceRepository,
    private readonly transactionRepo: TransactionRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ─── Smart Assignment Loop ────────────────────────────────────────────────
  /**
   * Called after an order transitions to READY. Finds the best nearby agent
   * and assigns the order. Fire-and-forget — failures are logged, not thrown.
   */
  async tryAssign(region: string, orderId: number, orderCreatedAt: Date): Promise<TryAssignResult> {
    const order = await this.orderRepo.findByCompositeId(region, orderId, orderCreatedAt);
    if (!order || order.status !== OrderStatus.READY) {
      this.logger.warn(`tryAssign: order ${orderId} not in READY state, skipping`);
      return { assigned: false };
    }

    const cfg = this.configService.get<any>('deliveries');
    const radiusMeters = cfg.assignmentRadiusMeters;
    const k = cfg.assignmentCandidateK;
    const staleSec = cfg.presenceStaleSec;
    const maxAttempts = cfg.maxReassignmentAttempts;

    // Check if we've exhausted all attempts
    if (order.assignmentAttempts >= maxAttempts) {
      this.logger.warn(
        `tryAssign: order ${order.publicId} exhausted ${maxAttempts} attempts`,
      );
      this.wsPublisher.emit(
        `admin:${region}:alerts`,
        'assignment.unassigned',
        { orderId: order.publicId },
      );
      return { assigned: false, exhausted: true };
    }

    // 1. Resolve branch coords
    const branch = await this.branchClient.getBranch(Number(order.branchId));

    // 2. Find candidates — try Redis first, fall back to Postgres GIST
    let candidates: AssignmentCandidate[] = [];
    let redisIsReliable = true;
    try {
      // Check if the region has ANY drivers in it at all (Fast O(1) check)
      const totalInRegion = await this.redis.zcard(presenceKeys.geo(region));
      // console.log(totalInRegion, "yea");
      if (totalInRegion === 0) {
        // Redis is totally empty. It might have crashed or evicted keys.
        // We cannot trust it. We must use Postgres.
        this.logger.warn(`Redis geo-index for ${region} is completely empty. Falling back to Postgres.`);
        redisIsReliable = false;
      } else {
        // Redis is healthy and has data. Get nearby drivers.
        candidates = await this.findCandidatesRedis(
            region, branch.lng, branch.lat, radiusMeters, k, staleSec, order.id
        );
      }
    } catch (err) {
      // Redis connection failed!
      this.logger.error(`Redis connection failed during assignment: ${(err as Error).message}`);
      redisIsReliable = false;
    }
    // if (!redisIsReliable) {
    //   // Postgres GIST fallback
    //   const pgCandidates = await this.presenceRepo.findOnlineNearestPostgres(
    //     region,
    //     branch.lat,
    //     branch.lng,
    //     k,
    //     staleSec,
    //   );
    //   // Filter out rejected agents (same check the Redis path does)
    //   const filtered: AssignmentCandidate[] = [];
    //   for (const c of pgCandidates) {
    //     const rejected = await this.presenceService.isRejected(order.id, c.agentId);
    //     if (!rejected) {
    //       filtered.push({
    //         agentId: c.agentId,
    //         distance: c.distanceMeters,
    //         activeOrders: 0,
    //         lastSeenAt: Date.now(),
    //       });
    //     }
    //   }
    //   candidates = filtered;
    // }

    if (candidates.length === 0) {
      this.logger.warn(
        `tryAssign: no candidates for order ${order.publicId} in region ${region}`,
      );
      return { assigned: false };
    }

    // 3. Sort by (active_orders ASC, distance ASC)
    candidates.sort((a, b) => {
      if (a.activeOrders !== b.activeOrders) return a.activeOrders - b.activeOrders;
      return a.distance - b.distance;
    });

    // 4. Try each candidate
    for (const candidate of candidates) {
      const result = await this.tryAssignToAgent(region, order, candidate.agentId);
      if (result) {
        // Success! Emit WS event
        this.wsPublisher.emit(
          `agent:${candidate.agentId}`,
          'task.assigned',
          DeliveryTaskResponseDTO.from(result),
        );
        return { assigned: true, agentId: candidate.agentId };
      }
    }

    // 5. All candidates failed
    this.logger.warn(
      `tryAssign: all ${candidates.length} candidates failed for order ${order.publicId}`,
    );
    return { assigned: false };
  }

  // ─── Manual assignment (admin) ────────────────────────────────────────────
  async manualAssign(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
    agentId: number,
  ): Promise<OrderEntity | null> {
    const order = await this.orderRepo.findByCompositeId(region, orderId, orderCreatedAt);
    if (!order || order.status !== OrderStatus.READY) {
      return null;
    }
    return this.tryAssignToAgent(region, order, agentId);
  }

  // ─── Reassignment (admin or system) ───────────────────────────────────────
  async reassign(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
  ): Promise<TryAssignResult> {
    const order = await this.orderRepo.findByCompositeId(region, orderId, orderCreatedAt);
    if (!order) return { assigned: false };

    // If currently assigned, clear the assignment first
    if (order.status === OrderStatus.ASSIGNED && order.deliveryAgentId) {
      const trx = await this.knex.db(region).transaction();
      try {
        await this.orderRepo.clearAssignment(region, orderId, orderCreatedAt, trx);
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }

      // Add current agent to the reject set
      await this.presenceService.addRejection(orderId, order.deliveryAgentId);
      await this.presenceService.incrementActiveOrders(region, order.deliveryAgentId, -1);
    }

    // Re-run the assignment loop
    return this.tryAssign(region, orderId, orderCreatedAt);
  }

  // ─── Agent reject / timeout ───────────────────────────────────────────────
  async handleAgentReject(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
    agentId: number,
  ): Promise<void> {
    // 1. Add to reject set
    await this.presenceService.addRejection(orderId, agentId);

    // 2. Clear assignment in DB
    const trx = await this.knex.db(region).transaction();
    try {
      await this.orderRepo.clearAssignment(region, orderId, orderCreatedAt, trx);
      await trx.commit();
    } catch (err) {
      await trx.rollback();
      throw err;
    }

    // 3. Decrement active_orders
    await this.presenceService.incrementActiveOrders(region, agentId, -1);

    // 4. Re-try assignment
    const result = await this.tryAssign(region, orderId, orderCreatedAt);
    if (!result.assigned && result.exhausted) {
      this.wsPublisher.emit(
        `admin:${region}:alerts`,
        'assignment.unassigned',
        { orderId },
      );
    }
  }

  // ─── Settlement on delivered ──────────────────────────────────────────────
  /**
   * Called in the same trx as the orders.status='delivered' flip.
   * - For COD: flip transactions(cod_collection) → succeeded.
   * - Insert agent_earnings.
   * - Phase 5 will add commission + restaurant_balances writes.
   */
  async settleDelivered(
    region: string,
    order: OrderEntity,
    trx: Knex.Transaction,
  ): Promise<void> {
    // 1. COD: flip cod_collection pending → succeeded
    if (order.paymentMethod === 'cod') {
      await trx('transactions')
        .where({
          order_id: order.id,
          order_created_at: order.createdAt,
          transaction_type: TransactionType.COD_COLLECTION,
          status: TransactionStatus.PENDING,
        })
        .update({
          status: TransactionStatus.SUCCEEDED,
          updated_at: trx.fn.now(),
        });
    }

    // 2. Fetch branch metadata (single call for both commission + agent earning)
    const branch = await this.branchClient.getBranch(Number(order.branchId));

    // 3. Compute commission (platform's cut of the delivery fee).
    //    branch.commission is in bps (e.g. 2000 = 20%).
    //    deliveryFee = 1500, commission = floor(1500 × 2000 / 10000) = 300
    const commissionBps = branch.commission ?? 0;
    const commission = Math.floor(branch.deliveryFee * commissionBps / 10000);

    // 4. Agent earning = deliveryFee − commission (the agent's share).
    //    deliveryFee = 1500, commission = 300 → agentEarning = 1200 (80%)
    if (order.deliveryAgentId) {
      const earningAmount = branch.deliveryFee - commission;

      await this.earningRepo.insertIdempotent(region, {
        region,
        agentId: order.deliveryAgentId,
        orderId: order.id,
        orderCreatedAt: order.createdAt,
        amount: earningAmount,
        currency: order.currency,
      }, trx);
    }

    // 5. Persist commission on the order row
    await trx('orders')
      .where({ id: order.id, created_at: order.createdAt })
      .update({ commission, updated_at: trx.fn.now() });

    // 6. Insert commission transaction
    await this.transactionRepo.create(
      region,
      {
        region,
        orderId: order.id,
        orderCreatedAt: order.createdAt,
        transactionType: TransactionType.COMMISSION,
        method: TransactionMethod.SYSTEM,
        providerId: null,
        providerReferenceId: null,
        status: TransactionStatus.SUCCEEDED,
        amount: commission,
        currency: order.currency,
        srcAccId: branch.restaurantId,
        dstAccId: null,
        idempotencyKey: `commission:${order.publicId}`,
      },
      trx,
    );

    // 7. Credit restaurant balance with the full subtotal
    //    (Commission is the platform's cut of the delivery fee, not restaurant revenue)
    await this.balanceRepo.incrementBalance(
      region,
      branch.restaurantId,
      order.currency,
      order.subtotal,
      trx,
    );
  }

  /**
   * Post-commit Redis cleanup after delivered.
   */
  async postDeliveredRedisCleanup(
    region: string,
    agentId: number,
    orderId: number,
  ): Promise<void> {
    await this.presenceService.incrementActiveOrders(region, agentId, -1);
    await this.presenceService.clearRejectSet(orderId);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Try to assign a specific agent to an order inside a transaction.
   * Returns the updated order on success, null on failure.
   */
  private async tryAssignToAgent(
    region: string,
    order: OrderEntity,
    agentId: number,
  ): Promise<OrderEntity | null> {
    const trx = await this.knex.db(region).transaction();
    try {
      const staleSec = this.configService.get<number>('deliveries.presenceStaleSec') ?? 300;

      // Lock the agent row
      const presence = await this.presenceRepo.claimForUpdate(region, agentId, trx);
      if (!presence || !presence.isOnline) {
        await trx.rollback();
        return null;
      }

      // Verify freshness
      const ageSec =
        (Date.now() - new Date(presence.lastSeenAt).getTime()) / 1000;
      if (ageSec > staleSec) {
        await trx.rollback();
        // Lazily evict from Redis
        await this.presenceService.evictStaleAgent(region, agentId);
        return null;
      }

      // Atomic assignment with status guard
      const updated = await this.orderRepo.assignToAgent(
        region,
        order.id,
        order.createdAt,
        agentId,
        trx,
      );

      if (!updated) {
        // Order raced to a different state
        await trx.rollback();
        return null;
      }

      await trx.commit();

      // Post-commit Redis updates
      await this.presenceService.incrementActiveOrders(region, agentId, 1);

      return updated;
    } catch (err) {
      await trx.rollback();
      this.logger.error(
        `tryAssignToAgent failed for agent ${agentId}, order ${order.publicId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Find candidates from Redis GEOSEARCH + pipeline HMGET for meta.
   * Drops stale, rejected, offline agents. Returns sorted candidates.
   */
  private async findCandidatesRedis(
      region: string,
      lng: number,
      lat: number,
      radiusMeters: number,
      k: number,
      staleSec: number,
      orderId: number,
  ): Promise<AssignmentCandidate[]> {
    const nearby = await this.presenceService.findNearbyAgentsRedis(
        region,
        lng,
        lat,
        radiusMeters,
        k,
    );

    if (nearby.length === 0) return [];

    const agentIds = nearby.map((n) => n.agentId);
    const meta = await this.presenceService.getAgentsMeta(region, agentIds);

    const now = Date.now();
    const staleMs = staleSec * 1000;
    const candidates: AssignmentCandidate[] = [];

    for (const n of nearby) {
      const m = meta.get(n.agentId);
      if (!m || !m.isOnline) continue;

      // 1. Drop stale agents (Heartbeat check)
      if (now - m.lastSeenAt > staleMs) {
        this.presenceService.evictStaleAgent(region, n.agentId).catch(() => {});
        continue;
      }

      // 2. Drop agents who already rejected this specific order
      const rejected = await this.presenceService.isRejected(orderId, n.agentId);
      if (rejected) continue;

      candidates.push({
        agentId: n.agentId,
        distance: n.distance,
        activeOrders: m.activeOrders,
        lastSeenAt: m.lastSeenAt,
      });
    }

    // 3. The "Fairness" Sort
    // We sort the candidates to balance the fleet workload
    return candidates.sort((a, b) => {
      // Priority 1: Lower workload (0 orders > 1 order)
      if (a.activeOrders !== b.activeOrders) {
        return a.activeOrders - b.activeOrders;
      }

      // Priority 2: Physical distance (Closer > Further)
      return a.distance - b.distance;
    });
  }
}
