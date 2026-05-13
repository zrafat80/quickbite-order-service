import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { AgentEarningEntity } from '../entity/agent-earning.entity';
import { AGENT_EARNING_COLUMNS } from '../agent.constants';
import { ShardedKnex } from '../../../lib/sharding/shards';
import { InsertEarningInput } from './agent-earning.repository.types';
import {
  applyCursorPagination,
  applyFilters,
  FilterParams,
  PaginationParams,
} from '../../../lib/pagination/cursor-pagination';

@Injectable()
export class AgentEarningRepository {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  private toEntity(row: any): AgentEarningEntity {
    return new AgentEarningEntity({
      id: Number(row.id),
      region: row.region,
      agentId: Number(row.agent_id),
      orderId: Number(row.order_id),
      orderCreatedAt: row.order_created_at,
      amount: Number(row.amount),
      currency: row.currency,
      earnedAt: row.earned_at,
    });
  }

  /**
   * Insert a single earning. UNIQUE on order_id makes this idempotent:
   * ON CONFLICT DO NOTHING returns no row → we return null.
   */
  async insertIdempotent(
    region: string,
    input: InsertEarningInput,
    trx?: Knex.Transaction,
  ): Promise<AgentEarningEntity | null> {
    const db = trx ?? this.knex.db(region);
    const result = await db.raw(
      `INSERT INTO agent_earnings (region, agent_id, order_id, order_created_at, amount, currency)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING ${(AGENT_EARNING_COLUMNS as readonly string[]).join(', ')}`,
      [
        input.region,
        input.agentId,
        input.orderId,
        input.orderCreatedAt,
        input.amount,
        input.currency,
      ],
    );
    const row = result.rows[0];
    return row ? this.toEntity(row) : null;
  }

  /**
   * Earnings list for the agent dashboard. Cursor pagination by earned_at DESC.
   * Joins orders to get public_id for display.
   */
  async findByAgent(
    region: string,
    agentId: number,
    filters: FilterParams[],
    params: PaginationParams,
  ): Promise<Array<AgentEarningEntity & { orderPublicId: string }>> {
    const db = this.knex.db(region);
    let q = db('agent_earnings as ae')
      .select([
        'ae.id',
        'ae.region',
        'ae.agent_id',
        'ae.order_id',
        'ae.order_created_at',
        'ae.amount',
        'ae.currency',
        'ae.earned_at',
        'o.public_id as order_public_id',
      ])
      .join('orders as o', function () {
        this.on('ae.order_id', '=', 'o.id').andOn(
          'ae.order_created_at',
          '=',
          'o.created_at',
        );
      })
      .where('ae.agent_id', agentId);
    q = applyFilters(q, filters);
    const rows = await applyCursorPagination(q, params);
    return rows.map((r: any) => {
      const entity = this.toEntity(r) as AgentEarningEntity & {
        orderPublicId: string;
      };
      entity.orderPublicId = r.order_public_id;
      return entity;
    });
  }

  /**
   * Sum + count for the agent's earnings summary.
   */
  async sumByAgent(
    region: string,
    agentId: number,
    from: Date,
    to: Date,
  ): Promise<{ count: number; sum: number; currency: string }> {
    const row = await this.knex
      .db(region)('agent_earnings')
      .select(
        this.knex.db(region).raw('COALESCE(SUM(amount), 0) as sum'),
        this.knex.db(region).raw('COUNT(*)::int as count'),
        this.knex.db(region).raw("COALESCE(MAX(currency), 'EGP') as currency"),
      )
      .where('agent_id', agentId)
      .andWhere('earned_at', '>=', from)
      .andWhere('earned_at', '<', to)
      .first();
    return {
      count: Number(row?.count ?? 0),
      sum: Number(row?.sum ?? 0),
      currency: (row?.currency as string) ?? 'EGP',
    };
  }
}
