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
      branchId: Number(row.branch_id),
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
        branch_id: input.branchId,
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
}
