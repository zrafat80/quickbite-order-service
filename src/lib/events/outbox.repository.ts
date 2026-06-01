import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import { InsertOutboxInput, OutboxRow } from './events.types';
import { ShardedKnex } from '../sharding/shards';

/**
 * Per-region outbox repo. Every mutating call takes a region so the row lands
 * in the shard whose drainer will pick it up. The drainer also injects a
 * region when claiming/marking rows.
 */
@Injectable()
export class OutboxRepository {
  constructor(@Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex) {}

  async insertOutboxEvent(
    region: string,
    trx: Knex.Transaction,
    input: InsertOutboxInput,
  ): Promise<void> {
    await trx('events_outbox').insert({
      aggregate_type: input.aggregateType,
      aggregate_id: String(input.aggregateId),
      event_type: input.eventType,
      event_id: randomUUID(),
      payload: JSON.stringify(input.payload),
    });
  }

  async insertOutboxEvents(
    region: string,
    trx: Knex.Transaction,
    inputs: InsertOutboxInput[],
  ): Promise<void> {
    if (inputs.length === 0) return;
    await trx('events_outbox').insert(
      inputs.map((input) => ({
        aggregate_type: input.aggregateType,
        aggregate_id: String(input.aggregateId),
        event_type: input.eventType,
        event_id: randomUUID(),
        payload: JSON.stringify(input.payload),
      })),
    );
  }

  async claimBatch(
    region: string,
    trx: Knex.Transaction,
    limit: number,
  ): Promise<OutboxRow[]> {
    const rows = await trx('events_outbox')
      .select(
        'id',
        'aggregate_type',
        'aggregate_id',
        'event_type',
        'event_id',
        'payload',
        'attempts',
      )
      .whereNull('dispatched_at')
      .orderBy('id', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked();
    return rows as OutboxRow[];
  }

  async markDispatchedBulk(
    region: string,
    trx: Knex.Transaction,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    await trx('events_outbox').whereIn('id', ids).update({
      dispatched_at: new Date(),
    });
  }

  async markFailed(
    region: string,
    trx: Knex.Transaction,
    id: string,
    err: string,
  ): Promise<void> {
    await trx('events_outbox')
      .where({ id })
      .update({
        attempts: this.knex.db(region).raw('attempts + 1'),
        last_error: err.slice(0, 2000),
      });
  }
}
