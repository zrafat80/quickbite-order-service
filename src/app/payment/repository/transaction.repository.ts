import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { TransactionEntity } from '../entity/transaction.entity';
import {
  TransactionMethod,
  TransactionStatus,
  TransactionType,
} from '../enums';
import { TRANSACTION_COLUMNS } from '../payment.constants';
import { ShardedKnex } from '../../../lib/sharding/shards';
import {
  CreateTransactionInput,
  UpdateTransactionStatusInput,
} from './transaction.repository.types';

@Injectable()
export class TransactionRepository {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  private toEntity(row: any): TransactionEntity {
    return new TransactionEntity({
      id: Number(row.id),
      region: row.region,
      orderId: row.order_id ? Number(row.order_id) : null,
      orderCreatedAt: row.order_created_at ?? null,
      transactionType: row.transaction_type as TransactionType,
      method: row.method as TransactionMethod,
      providerId: row.provider_id ? Number(row.provider_id) : null,
      providerReferenceId: row.provider_reference_id ?? null,
      providerOrderId: row.provider_order_id ?? null,
      status: row.status as TransactionStatus,
      amount: Number(row.amount),
      currency: row.currency,
      srcAccId: row.src_acc_id ? Number(row.src_acc_id) : null,
      dstAccId: row.dst_acc_id ? Number(row.dst_acc_id) : null,
      isRefunded: Boolean(row.is_refunded),
      refundedPaymentId: row.refunded_payment_id
        ? Number(row.refunded_payment_id)
        : null,
      idempotencyKey: row.idempotency_key ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  async create(
    region: string,
    input: CreateTransactionInput,
    trx?: Knex.Transaction,
  ): Promise<TransactionEntity> {
    const db = trx ?? this.knex.db(region);
    const [row] = await db('transactions')
      .insert({
        region: input.region,
        order_id: input.orderId,
        order_created_at: input.orderCreatedAt,
        transaction_type: input.transactionType,
        method: input.method,
        provider_id: input.providerId,
        provider_reference_id: input.providerReferenceId,
        provider_order_id: input.providerOrderId ?? null,
        status: input.status,
        amount: input.amount,
        currency: input.currency,
        src_acc_id: input.srcAccId,
        dst_acc_id: input.dstAccId,
        refunded_payment_id: input.refundedPaymentId ?? null,
        idempotency_key: input.idempotencyKey,
      })
      .returning(TRANSACTION_COLUMNS as unknown as string[]);
    return this.toEntity(row);
  }

  async findById(
    region: string,
    id: number,
  ): Promise<TransactionEntity | null> {
    const row = await this.knex
      .db(region)('transactions')
      .select(TRANSACTION_COLUMNS as unknown as string[])
      .where('id', id)
      .first();
    return row ? this.toEntity(row) : null;
  }

  async findByIdempotencyKey(
    region: string,
    key: string,
  ): Promise<TransactionEntity | null> {
    const row = await this.knex
      .db(region)('transactions')
      .select(TRANSACTION_COLUMNS as unknown as string[])
      .where('idempotency_key', key)
      .first();
    return row ? this.toEntity(row) : null;
  }

  async findByOrderId(
    region: string,
    orderId: number,
    orderCreatedAt: Date,
  ): Promise<TransactionEntity[]> {
    const rows = await this.knex
      .db(region)('transactions')
      .select(TRANSACTION_COLUMNS as unknown as string[])
      .where({ order_id: orderId, order_created_at: orderCreatedAt })
      .orderBy('created_at', 'asc');
    return rows.map((r: any) => this.toEntity(r));
  }

  async findRefundsForCharge(
    region: string,
    chargeId: number,
  ): Promise<TransactionEntity[]> {
    const rows = await this.knex
      .db(region)('transactions')
      .select(TRANSACTION_COLUMNS as unknown as string[])
      .where('refunded_payment_id', chargeId)
      .andWhere('transaction_type', TransactionType.REFUND);
    return rows.map((r: any) => this.toEntity(r));
  }

  async updateStatus(
    region: string,
    id: number,
    input: UpdateTransactionStatusInput,
    trx?: Knex.Transaction,
  ): Promise<TransactionEntity> {
    const db = trx ?? this.knex.db(region);
    const update: Record<string, unknown> = {
      status: input.status,
      updated_at: this.knex.db(region).fn.now(),
    };
    if (input.providerReferenceId !== undefined) {
      update.provider_reference_id = input.providerReferenceId;
    }
    const [row] = await db('transactions')
      .where('id', id)
      .update(update)
      .returning(TRANSACTION_COLUMNS as unknown as string[]);
    return this.toEntity(row);
  }

  async markRefunded(
    region: string,
    chargeId: number,
    refundId: number,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const db = trx ?? this.knex.db(region);
    await db('transactions')
      .where('id', chargeId)
      .update({
        is_refunded: true,
        refunded_payment_id: refundId,
        updated_at: this.knex.db(region).fn.now(),
      });
  }
}
