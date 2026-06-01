import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ShardedKnex } from '../sharding/shards';
import { OrderEventsBroker } from './order-events.broker';
import { OutboxRepository } from './outbox.repository';

/**
 * Per-region outbox drainer. Each tick iterates every configured region,
 * claims a batch with FOR UPDATE SKIP LOCKED in that region's DB, publishes
 * each row to `order.events`, marks dispatched in bulk. On publish failure:
 * bail out of the batch (broker is sick) and let the next tick retry.
 */
@Injectable()
export class OutboxDrainService {
  private readonly logger = new Logger(OutboxDrainService.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly outboxRepo: OutboxRepository,
    private readonly broker: OrderEventsBroker,
    private readonly configService: ConfigService,
  ) {}

  // Default 2s tick — overridable via OUTBOUND_EVENTS_DRAIN_TICK_SEC.
  // Cron expression "*/2 * * * * *" runs every 2 seconds.
  @Cron('*/2 * * * * *')
  async tick(): Promise<void> {
    for (const region of this.knex.regions()) {
      try {
        await this.drainOne(region);
      } catch (err) {
        this.logger.error(
          `outbox drain failed for region=${region}: ${(err as Error).message}`,
        );
      }
    }
  }

  async drainOne(region: string): Promise<{ moved: number }> {
    try {
      await this.broker.ensureConnected();
    } catch (err) {
      this.logger.warn(
        `broker unavailable, skipping drain for region=${region}: ${(err as Error).message}`,
      );
      return { moved: 0 };
    }

    const batchSize =
      this.configService.get<number>('outbound.batchSize') ?? 100;
    const trx = await this.knex.db(region).transaction();

    try {
      const rows = await this.outboxRepo.claimBatch(region, trx, batchSize);
      if (rows.length === 0) {
        await trx.commit();
        return { moved: 0 };
      }

      const successfulIds: string[] = [];
      let failedRowId: string | null = null;
      let failedMsg = '';

      for (const row of rows) {
        const envelope = {
          eventId: row.event_id,
          eventType: row.event_type,
          occurredAt: new Date().toISOString(),
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: row.payload,
        };

        try {
          await this.broker.publish(
            row.event_type,
            Buffer.from(JSON.stringify(envelope), 'utf8'),
          );
          successfulIds.push(row.id);
        } catch (err) {
          failedMsg = (err as Error).message ?? String(err);
          failedRowId = row.id;
          this.logger.error(
            `outbox publish failed (region=${region}, id=${row.id}): ${failedMsg}`,
          );
          break;
        }
      }

      if (successfulIds.length > 0) {
        await this.outboxRepo.markDispatchedBulk(region, trx, successfulIds);
      }
      if (failedRowId) {
        await this.outboxRepo.markFailed(region, trx, failedRowId, failedMsg);
      }

      await trx.commit();
      return { moved: successfulIds.length };
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }
}
