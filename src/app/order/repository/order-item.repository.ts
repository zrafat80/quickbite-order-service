import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { OrderItemEntity } from '../entity/order-item.entity';
import { ORDER_ITEM_COLUMNS } from '../order.constants';
import { ShardedKnex } from '../../../lib/sharding/shards';
import {
  BulkInsertItemInput,
  FindByOrderIdsKey,
} from './order-item.repository.types';

@Injectable()
export class OrderItemRepository {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  private toEntity(row: any): OrderItemEntity {
    return new OrderItemEntity({
      id: Number(row.id),
      region: row.region,
      orderId: Number(row.order_id),
      orderCreatedAt: row.order_created_at,
      productId: Number(row.product_id),
      quantity: Number(row.quantity),
      unitPriceSnapshot: Number(row.unit_price_snapshot),
      nameSnapshot: row.name_snapshot,
      imageUrlSnapshot: row.image_url_snapshot ?? null,
      lineTotal: Number(row.line_total),
      createdAt: row.created_at,
    });
  }

  async bulkInsert(
    inputs: BulkInsertItemInput[],
    trx: Knex.Transaction,
  ): Promise<OrderItemEntity[]> {
    if (inputs.length === 0) return [];
    const rows = await trx('order_items')
      .insert(
        inputs.map((i) => ({
          region: i.region,
          order_id: i.orderId,
          order_created_at: i.orderCreatedAt,
          product_id: i.productId,
          quantity: i.quantity,
          unit_price_snapshot: i.unitPriceSnapshot,
          name_snapshot: i.nameSnapshot,
          image_url_snapshot: i.imageUrlSnapshot,
          line_total: i.lineTotal,
        })),
      )
      .returning(ORDER_ITEM_COLUMNS as unknown as string[]);
    return rows.map((r: any) => this.toEntity(r));
  }

  // Single batch fetch for the orders-list expansion (guards against N+1).
  async findByOrderIds(
    region: string,
    keys: FindByOrderIdsKey[],
  ): Promise<OrderItemEntity[]> {
    if (keys.length === 0) return [];
    const tuples = keys.map((k) => [k.orderId, k.orderCreatedAt]);
    const rows = await this.knex
      .db(region)('order_items')
      .select(ORDER_ITEM_COLUMNS as unknown as string[])
      .whereIn(['order_id', 'order_created_at'], tuples as any);
    return rows.map((r: any) => this.toEntity(r));
  }
}
