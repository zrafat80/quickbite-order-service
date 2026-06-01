import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { AgentPresenceEntity } from '../entity/agent-presence.entity';
import { AGENT_PRESENCE_COLUMNS } from '../presence.constants';
import { ShardedKnex } from '../../../lib/sharding/shards';
import {
  NearestAgentRow,
  UpsertPresenceInput,
} from './agent-presence.repository.types';

@Injectable()
export class AgentPresenceRepository {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  private toEntity(row: any): AgentPresenceEntity {
    return new AgentPresenceEntity({
      agentId: Number(row.agent_id),
      region: row.region,
      isOnline: Boolean(row.is_online),
      lastLat: row.last_lat != null ? Number(row.last_lat) : null,
      lastLng: row.last_lng != null ? Number(row.last_lng) : null,
      lastSeenAt: row.last_seen_at,
      updatedAt: row.updated_at,
    });
  }

  /**
   * UPSERT: create row if absent, flip is_online=true + update coords.
   */
  async upsertOnline(
    region: string,
    input: UpsertPresenceInput,
    trx?: Knex.Transaction,
  ): Promise<AgentPresenceEntity> {
    const db = trx ?? this.knex.db(region);
    const [row] = await db.raw(
      `INSERT INTO agent_presence (agent_id, region, is_online, last_lat, last_lng, last_seen_at, updated_at)
       VALUES (?, ?, TRUE, ?, ?, NOW(), NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         is_online = TRUE,
         last_lat = EXCLUDED.last_lat,
         last_lng = EXCLUDED.last_lng,
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING ${(AGENT_PRESENCE_COLUMNS as readonly string[]).join(', ')}`,
      [input.agentId, input.region, input.lat, input.lng],
    ).then((res: any) => res.rows);
    return this.toEntity(row);
  }

  /**
   * Set is_online=false. Does NOT check active deliveries — caller does that.
   */
  async updateOffline(
    region: string,
    agentId: number,
    trx?: Knex.Transaction,
  ): Promise<AgentPresenceEntity | null> {
    const db = trx ?? this.knex.db(region);
    const [row] = await db.raw(
      `UPDATE agent_presence SET
         is_online = FALSE,
         last_seen_at = NOW(),
         updated_at = NOW()
       WHERE agent_id = ?
       RETURNING ${(AGENT_PRESENCE_COLUMNS as readonly string[]).join(', ')}`,
      [agentId],
    ).then((res: any) => res.rows);
    return row ? this.toEntity(row) : null;
  }

  /**
   * Heartbeat update: new coords + last_seen_at. Only if already online.
   */
  async updatePing(
    region: string,
    agentId: number,
    lat: number,
    lng: number,
    trx?: Knex.Transaction,
  ): Promise<AgentPresenceEntity | null> {
    const db = trx ?? this.knex.db(region);
    const [row] = await db.raw(
      `UPDATE agent_presence SET
         last_lat = ?,
         last_lng = ?,
         last_seen_at = NOW(),
         updated_at = NOW()
       WHERE agent_id = ? AND is_online = TRUE
       RETURNING ${(AGENT_PRESENCE_COLUMNS as readonly string[]).join(', ')}`,
      [lat, lng, agentId],
    ).then((res: any) => res.rows);
    return row ? this.toEntity(row) : null;
  }

  /**
   * SELECT ... FOR UPDATE. Used inside the assignment trx to lock the agent.
   */
  async claimForUpdate(
    region: string,
    agentId: number,
    trx: Knex.Transaction,
  ): Promise<AgentPresenceEntity | null> {
    const [row] = await trx.raw(
      `SELECT ${(AGENT_PRESENCE_COLUMNS as readonly string[]).join(', ')}
       FROM agent_presence
       WHERE agent_id = ?
       FOR UPDATE`,
      [agentId],
    ).then((res: any) => res.rows);
    return row ? this.toEntity(row) : null;
  }

  async findByAgentId(
    region: string,
    agentId: number,
  ): Promise<AgentPresenceEntity | null> {
    const row = await this.knex
      .db(region)('agent_presence')
      .select(AGENT_PRESENCE_COLUMNS as unknown as string[])
      .where('agent_id', agentId)
      .first();
    return row ? this.toEntity(row) : null;
  }

  /**
   * Postgres GIST fallback for the assignment scan when Redis is empty.
   * Uses the `idx_agent_presence_location_gist` partial index.
   */
  async findOnlineNearestPostgres(
    region: string,
    lat: number,
    lng: number,
    k: number,
    staleSec: number,
  ): Promise<NearestAgentRow[]> {
    const rows = await this.knex.db(region).raw(
      `SELECT
         agent_id,
         ST_Distance(location, ST_MakePoint(?, ?)::geography) AS distance_meters
       FROM agent_presence
       WHERE is_online = TRUE
         AND last_seen_at > NOW() - (? || ' seconds')::interval
         AND location IS NOT NULL
       ORDER BY location <-> ST_MakePoint(?, ?)::geography
       LIMIT ?`,
      [lng, lat, staleSec, lng, lat, k],
    );
    return rows.rows.map((r: any) => ({
      agentId: Number(r.agent_id),
      distanceMeters: Number(r.distance_meters),
    }));
  }
}
