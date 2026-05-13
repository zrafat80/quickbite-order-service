import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { PaymentSessionEntity } from '../entity/payment-session.entity';
import { PaymentSessionStatus } from '../enums';
import { PAYMENT_SESSION_COLUMNS } from '../payment.constants';
import { ShardedKnex } from '../../../lib/sharding/shards';
import {
  CreatePaymentSessionInput,
  UpdatePaymentSessionStatusInput,
} from './payment-session.repository.types';

@Injectable()
export class PaymentSessionRepository {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  private toEntity(row: any): PaymentSessionEntity {
    return new PaymentSessionEntity({
      id: Number(row.id),
      region: row.region,
      orderId: Number(row.order_id),
      orderCreatedAt: row.order_created_at,
      providerId: Number(row.provider_id),
      providerSessionId: row.provider_session_id,
      redirectUrl: row.redirect_url,
      amount: Number(row.amount),
      currency: row.currency,
      status: row.status as PaymentSessionStatus,
      rawInitPayload: row.raw_init_payload,
      rawLastPayload: row.raw_last_payload ?? null,
      expiresAt: row.expires_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  async create(
    region: string,
    input: CreatePaymentSessionInput,
    trx?: Knex.Transaction,
  ): Promise<PaymentSessionEntity> {
    const db = trx ?? this.knex.db(region);
    const [row] = await db('payment_sessions')
      .insert({
        region: input.region,
        order_id: input.orderId,
        order_created_at: input.orderCreatedAt,
        provider_id: input.providerId,
        provider_session_id: input.providerSessionId,
        redirect_url: input.redirectUrl,
        amount: input.amount,
        currency: input.currency,
        status: input.status,
        raw_init_payload: input.rawInitPayload as any,
        expires_at: input.expiresAt,
      })
      .returning(PAYMENT_SESSION_COLUMNS as unknown as string[]);
    return this.toEntity(row);
  }

  async findById(
    region: string,
    id: number,
  ): Promise<PaymentSessionEntity | null> {
    const row = await this.knex
      .db(region)('payment_sessions')
      .select(PAYMENT_SESSION_COLUMNS as unknown as string[])
      .where('id', id)
      .first();
    return row ? this.toEntity(row) : null;
  }

  async findByProviderSessionId(
    region: string,
    providerSessionId: string,
  ): Promise<PaymentSessionEntity | null> {
    const row = await this.knex
      .db(region)('payment_sessions')
      .select(PAYMENT_SESSION_COLUMNS as unknown as string[])
      .where('provider_session_id', providerSessionId)
      .first();
    return row ? this.toEntity(row) : null;
  }

  // Latest active session for an order (status IN initialized | pending).
  async findLatestActiveByOrderId(
      region: string,
      orderId: number,
      orderCreatedAt: Date,
  ): Promise<PaymentSessionEntity | null> {
    const db = this.knex.db(region); // Store db reference for the fn.now() call

    const row = await db('payment_sessions')
        .select(PAYMENT_SESSION_COLUMNS as unknown as string[])
        .where({ order_id: orderId, order_created_at: orderCreatedAt })
        .whereIn('status', [
          PaymentSessionStatus.INITIALIZED,
          PaymentSessionStatus.PENDING,
          PaymentSessionStatus.AUTHORIZED,
        ])
        // --- THE FIX: Ensure it is not expired ---
        .where(function() {
          this.whereNull('expires_at').orWhere('expires_at', '>', db.fn.now());
        })
        // -----------------------------------------
        .orderBy('created_at', 'desc')
        .first();

    return row ? this.toEntity(row) : null;
  }
  /**
   * Sweeper-driven bulk transition: flips all sessions whose `expires_at`
   * has passed (and which are still in a non-final state) to `expired`.
   * One UPDATE, one round-trip per region. Returns the number of rows touched.
   */
  async expireStaleSessions(
    region: string,
    trx?: Knex.Transaction,
  ): Promise<number> {
    const db = trx ?? this.knex.db(region);
    const count = await db('payment_sessions')
      .whereIn('status', [
        PaymentSessionStatus.INITIALIZED,
        PaymentSessionStatus.PENDING,
        PaymentSessionStatus.AUTHORIZED,
      ])
      .andWhereRaw('expires_at IS NOT NULL AND expires_at < NOW()')
      .update({
        status: PaymentSessionStatus.EXPIRED,
        updated_at: this.knex.db(region).fn.now(),
      });
    return Number(count);
  }

  async updateStatus(
    region: string,
    id: number,
    input: UpdatePaymentSessionStatusInput,
    trx?: Knex.Transaction,
  ): Promise<PaymentSessionEntity> {
    const db = trx ?? this.knex.db(region);
    const update: Record<string, unknown> = {
      status: input.status,
      updated_at: this.knex.db(region).fn.now(),
    };
    if (input.rawLastPayload !== undefined) {
      update.raw_last_payload = input.rawLastPayload as any;
    }
    const [row] = await db('payment_sessions')
      .where('id', id)
      .update(update)
      .returning(PAYMENT_SESSION_COLUMNS as unknown as string[]);
    return this.toEntity(row);
  }
}
