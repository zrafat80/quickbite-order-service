import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { OrderEntity } from '../entity/order.entity';
import { OrderStatus, PaymentMethod } from '../enums';
import { ORDER_COLUMNS } from '../order.constants';
import { ShardedKnex } from '../../../lib/sharding/shards';
import {
  applyCursorPagination,
  applyFilters,
} from '../../../lib/pagination/cursor-pagination';
import {
  CreateOrderInput,
  ExpirableOrderRow,
  ListByBranchOptions,
  ListByCustomerOptions,
  OrderOwnershipView,
} from './order.repository.types';

@Injectable()
export class OrderRepository {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  private toEntity(row: any): OrderEntity {
    return new OrderEntity({
      id: Number(row.id),
      region: row.region,
      publicId: row.public_id,
      countryCode: row.country_code,
      restaurantId: Number(row.restaurant_id),
      restaurantOwnerId: row.restaurant_owner_id != null ? Number(row.restaurant_owner_id) : null,
      branchId: Number(row.branch_id),
      branchLat: row.branch_lat != null ? Number(row.branch_lat) : null,
      branchLng: row.branch_lng != null ? Number(row.branch_lng) : null,
      customerId: Number(row.customer_id),
      customerAddressId: Number(row.customer_address_id),
      deliveryLat: Number(row.delivery_lat),
      deliveryLng: Number(row.delivery_lng),
      deliveryAddressTextSnapshot: row.delivery_address_text_snapshot,
      status: row.status as OrderStatus,
      subtotal: Number(row.subtotal),
      deliveryFee: Number(row.delivery_fee),
      serviceFee: Number(row.service_fee),
      total: Number(row.total),
      commission: Number(row.commission),
      currency: row.currency,
      paymentMethod: row.payment_method as PaymentMethod,
      deliveryAgentId: row.delivery_agent_id ? Number(row.delivery_agent_id) : null,
      assignmentAttempts: Number(row.assignment_attempts ?? 0),
      lastAssignmentAt: row.last_assignment_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acceptedAt: row.accepted_at,
      rejectedAt: row.rejected_at,
      readyAt: row.ready_at,
      assignedAt: row.assigned_at,
      pickedAt: row.picked_at,
      deliveredAt: row.delivered_at,
      cancelledAt: row.cancelled_at,
    });
  }

  async createOrder(
    region: string,
    input: CreateOrderInput,
    trx: Knex.Transaction,
  ): Promise<OrderEntity> {
    const [row] = await trx('orders')
      .insert({
        region: input.region,
        public_id: input.publicId,
        country_code: input.countryCode,
        restaurant_id: input.restaurantId,
        restaurant_owner_id: input.restaurantOwnerId,
        branch_id: input.branchId,
        branch_lat: input.branchLat,
        branch_lng: input.branchLng,
        customer_id: input.customerId,
        customer_address_id: input.customerAddressId,
        delivery_lat: input.deliveryLat,
        delivery_lng: input.deliveryLng,
        delivery_address_text_snapshot: input.deliveryAddressTextSnapshot,
        status: input.status,
        subtotal: input.subtotal,
        delivery_fee: input.deliveryFee,
        service_fee: input.serviceFee,
        total: input.total,
        currency: input.currency,
        payment_method: input.paymentMethod,
      })
      .returning(ORDER_COLUMNS as unknown as string[]);
    return this.toEntity(row);
  }

  async findByPublicId(
    region: string,
    publicId: string,
  ): Promise<OrderEntity | null> {
    const row = await this.knex
      .db(region)('orders')
      .select(ORDER_COLUMNS as unknown as string[])
      .where('public_id', publicId)
      .first();
    return row ? this.toEntity(row) : null;
  }

  /**
   * Sweeper query: returns orders still in `pending_payment` past the grace
   * window with NO active session. "Active" mirrors
   * PaymentSessionRepository.findLatestActiveByOrderId — status in
   * (initialized, pending, authorized) AND not past expires_at.
   */
  async findExpirablePendingPayment(
    region: string,
    graceMinutes: number,
    limit: number,
  ): Promise<ExpirableOrderRow[]> {
    const db = this.knex.db(region);
    const rows = await db('orders as o')
      .select(['o.id', 'o.public_id', 'o.created_at', 'o.branch_id'])
      .where('o.region', region)
      .andWhere('o.status', OrderStatus.PENDING_PAYMENT)
      .andWhereRaw(`o.created_at + (? || ' minutes')::interval < NOW()`, [
        graceMinutes,
      ])
      .andWhereRaw(
        `NOT EXISTS (
          SELECT 1 FROM payment_sessions s
          WHERE s.order_id = o.id
            AND s.order_created_at = o.created_at
            AND s.status IN ('initialized', 'pending', 'authorized')
            AND (s.expires_at IS NULL OR s.expires_at > NOW())
        )`,
      )
      .orderBy('o.created_at', 'asc')
      .limit(limit);
    return rows.map((r: any) => ({
      id: Number(r.id),
      publicId: r.public_id,
      createdAt: r.created_at,
      branchId: Number(r.branch_id),
    }));
  }

  async findOwnershipByCompositeId(
    region: string,
    id: number,
    createdAt: Date,
  ): Promise<OrderOwnershipView | null> {
    const row = await this.knex
      .db(region)('orders')
      .select(['id', 'public_id', 'customer_id', 'restaurant_id'])
      .where({ id, created_at: createdAt })
      .first();
    if (!row) return null;
    return {
      id: Number(row.id),
      publicId: row.public_id,
      customerId: Number(row.customer_id),
      restaurantId: Number(row.restaurant_id),
    };
  }

  async findByCustomer(
    region: string,
    customerId: number,
    options: ListByCustomerOptions,
  ): Promise<OrderEntity[]> {
    const db = this.knex.db(region);
    let q = db('orders')
      .select(ORDER_COLUMNS as unknown as string[])
      .where('customer_id', customerId);
    q = applyFilters(q, options.filters);
    const rows = await applyCursorPagination(q, options.params);
    return rows.map((r: any) => this.toEntity(r));
  }

  async findByBranch(
    region: string,
    branchId: number,
    options: ListByBranchOptions,
  ): Promise<OrderEntity[]> {
    const db = this.knex.db(region);
    let q = db('orders')
      .select(ORDER_COLUMNS as unknown as string[])
      .where('branch_id', branchId);
    q = applyFilters(q, options.filters);
    const rows = await applyCursorPagination(q, options.params);
    return rows.map((r: any) => this.toEntity(r));
  }

  async updateStatus(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
    nextStatus: OrderStatus,
    timestampColumn: string | null,
    trx: Knex.Transaction,
  ): Promise<OrderEntity> {
    const update: Record<string, unknown> = {
      status: nextStatus,
      updated_at: this.knex.db(region).fn.now(),
    };
    if (timestampColumn) update[timestampColumn] = this.knex.db(region).fn.now();
    const [row] = await trx('orders')
      .where({ id: orderId, created_at: orderCreatedAt })
      .update(update)
      .returning(ORDER_COLUMNS as unknown as string[]);
    return this.toEntity(row);
  }
  async bulkCancelPendingPayment(
      region: string,
      ids: number[],
      trx: Knex.Transaction,
  ): Promise<number> {
    if (!ids || ids.length === 0) return 0;

    const updatedCount = await trx('orders')
        .whereIn('id', ids)
        .andWhere('status', OrderStatus.PENDING_PAYMENT)
        .update({
          status: OrderStatus.CANCELLED,
          cancelled_at: trx.fn.now(),
        });

    return updatedCount;
  }

  // ─── Agent-related queries (Phase 3) ────────────────────────────────────

  /**
   * Agent task list. Filtered by delivery_agent_id + optional status.
   * Uses idx_orders_delivery_agent_id_status.
   */
  async findByAgent(
    region: string,
    agentId: number,
    statusFilter: string | undefined,
    params: import('../../../lib/pagination/cursor-pagination').PaginationParams,
  ): Promise<OrderEntity[]> {
    const db = this.knex.db(region);
    let q = db('orders')
      .select(ORDER_COLUMNS as unknown as string[])
      .where('delivery_agent_id', agentId);
    if (statusFilter) {
      q = q.andWhere('status', statusFilter);
    }
    const { applyCursorPagination: applyCursor } = await import(
      '../../../lib/pagination/cursor-pagination'
    );
    const rows = await applyCursor(q, params);
    return rows.map((r: any) => this.toEntity(r));
  }

  /**
   * Find orders actively assigned to this agent (status IN assigned, picked).
   * Used to check whether the agent can go offline.
   */
  async findActiveByAgent(
    region: string,
    agentId: number,
  ): Promise<OrderEntity[]> {
    const rows = await this.knex
      .db(region)('orders')
      .select(ORDER_COLUMNS as unknown as string[])
      .where('delivery_agent_id', agentId)
      .whereIn('status', [OrderStatus.ASSIGNED, OrderStatus.PICKED]);
    return rows.map((r: any) => this.toEntity(r));
  }

  /**
   * Atomic assignment: UPDATE orders SET status='assigned', delivery_agent_id=?,
   * assignment_attempts+1 WHERE id=? AND status='ready'.
   * Returns null if 0 rows matched (order raced to a different state).
   */
  async assignToAgent(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
    agentId: number,
    trx: Knex.Transaction,
  ): Promise<OrderEntity | null> {
    const rows = await trx('orders')
      .where({ id: orderId, created_at: orderCreatedAt, status: OrderStatus.READY })
      .update({
        status: OrderStatus.ASSIGNED,
        delivery_agent_id: agentId,
        assigned_at: trx.fn.now(),
        last_assignment_at: trx.fn.now(),
        assignment_attempts: trx.raw('assignment_attempts + 1'),
        updated_at: trx.fn.now(),
      })
      .returning(ORDER_COLUMNS as unknown as string[]);
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  /**
   * Clear assignment: flip order back to 'ready', remove delivery_agent_id.
   * Used after reject/timeout so the loop can try the next candidate.
   */
  async clearAssignment(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
    trx: Knex.Transaction,
  ): Promise<OrderEntity | null> {
    const rows = await trx('orders')
      .where({ id: orderId, created_at: orderCreatedAt, status: OrderStatus.ASSIGNED })
      .update({
        status: OrderStatus.READY,
        delivery_agent_id: null,
        assigned_at: null,
        accepted_at: null,
        updated_at: trx.fn.now(),
      })
      .returning(ORDER_COLUMNS as unknown as string[]);
    return rows.length > 0 ? this.toEntity(rows[0]) : null;
  }

  /**
   * Fetch a single order by internal id + created_at (composite PK).
   * Used by the assignment service to load the order after it has the id.
   */
  async findByCompositeId(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
  ): Promise<OrderEntity | null> {
    const row = await this.knex
      .db(region)('orders')
      .select(ORDER_COLUMNS as unknown as string[])
      .where({ id: orderId, created_at: orderCreatedAt })
      .first();
    return row ? this.toEntity(row) : null;
  }

  async findIgnoredAssignments(region: string, timeoutSec: number): Promise<OrderEntity[]> {
    const rows = await this.knex.db(region)('orders')
      .select(ORDER_COLUMNS as unknown as string[])
      .where('status', OrderStatus.ASSIGNED)
      .whereNull('accepted_at')
      .whereRaw(`last_assignment_at < NOW() - (? || ' seconds')::interval`, [timeoutSec]);
    return rows.map((r: any) => this.toEntity(r));
  }

  async findAllAssigned(region: string): Promise<OrderEntity[]> {
    const rows = await this.knex.db(region)('orders')
      .select(ORDER_COLUMNS as unknown as string[])
      .where('status', OrderStatus.ASSIGNED)
      .whereNotNull('delivery_agent_id');
    return rows.map((r: any) => this.toEntity(r));
  }

  // Orders that have been sitting in 'ready' without a successful assignment.
  // `last_assignment_at` is NULL until an actual candidate is tried, so we
  // fall back to `ready_at` for the first sweeper pass. Uses the partial
  // index idx_orders_status_created_at (status IN ('ready','assigned')).
  async findStaleReady(region: string, staleSec: number): Promise<OrderEntity[]> {
    const rows = await this.knex.db(region)('orders')
      .select(ORDER_COLUMNS as unknown as string[])
      .where('status', OrderStatus.READY)
      .whereRaw(
        `COALESCE(last_assignment_at, ready_at) < NOW() - (? || ' seconds')::interval`,
        [staleSec],
      );
    return rows.map((r: any) => this.toEntity(r));
  }

  // Stamps last_assignment_at = NOW() without touching status. Called by the
  // ready-sweeper before re-running tryAssign so a no-candidates outcome
  // doesn't cause the same row to be re-picked on every 10s tick.
  async touchAssignmentAttempt(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
  ): Promise<void> {
    await this.knex.db(region)('orders')
      .where({ id: orderId, created_at: orderCreatedAt })
      .update({ last_assignment_at: this.knex.db(region).fn.now() });
  }
}
