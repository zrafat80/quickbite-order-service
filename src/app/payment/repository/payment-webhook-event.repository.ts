import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { PaymentWebhookEventEntity } from '../entity/payment-webhook-event.entity';
import { PAYMENT_WEBHOOK_EVENT_COLUMNS } from '../payment.constants';
import { ShardedKnex } from '../../../lib/sharding/shards';

export interface InsertWebhookEventInput {
  region: string;
  providerId: number;
  providerEventId: string;
  eventType: string;
  signature: string | null;
  payload: unknown;
}

@Injectable()
export class PaymentWebhookEventRepository {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  private toEntity(row: any): PaymentWebhookEventEntity {
    return new PaymentWebhookEventEntity({
      id: Number(row.id),
      region: row.region,
      providerId: Number(row.provider_id),
      providerEventId: row.provider_event_id,
      eventType: row.event_type,
      signature: row.signature ?? null,
      payload: row.payload,
      receivedAt: row.received_at,
      processedAt: row.processed_at ?? null,
      processError: row.process_error ?? null,
    });
  }

  /**
   * Insert with ON CONFLICT DO NOTHING. Returns the inserted entity, or null
   * if the (provider_id, provider_event_id) duplicate was already stored —
   * caller treats null as "ack and short-circuit".
   */
  async insertOrIgnore(
    region: string,
    input: InsertWebhookEventInput,
  ): Promise<PaymentWebhookEventEntity | null> {
    const rows = await this.knex
      .db(region)('payment_webhook_events')
      .insert({
        region: input.region,
        provider_id: input.providerId,
        provider_event_id: input.providerEventId,
        event_type: input.eventType,
        signature: input.signature,
        payload: input.payload as any,
      })
      .onConflict(['provider_id', 'provider_event_id'])
      .ignore()
      .returning(PAYMENT_WEBHOOK_EVENT_COLUMNS as unknown as string[]);
    if (rows.length === 0) return null;
    return this.toEntity(rows[0]);
  }

  async markProcessed(
    region: string,
    id: number,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const db = trx ?? this.knex.db(region);
    await db('payment_webhook_events')
      .where('id', id)
      .update({
        processed_at: this.knex.db(region).fn.now(),
        process_error: null,
      });
  }

  async markFailed(
    region: string,
    id: number,
    error: string,
  ): Promise<void> {
    await this.knex
      .db(region)('payment_webhook_events')
      .where('id', id)
      .update({ process_error: error });
  }
}
