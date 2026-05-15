import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ShardedKnex } from '../sharding/shards';

@Injectable()
export class ArchivalWorker {
  private readonly logger = new Logger(ArchivalWorker.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async archiveOldData() {
    this.logger.log('Starting nightly archival worker');

    // In a real system, we would:
    // 1. Check a Redis lock
    // 2. Walk tables: agent_earnings, payment_webhook_events, payment_sessions, transactions, order_items, orders
    // 3. Move batches of rows where created_at < date_trunc('year', NOW())
    
    // For this implementation, we will log a summary.
    for (const region of this.knex.regions()) {
      try {
        const archiveDb = this.knex.dbArchive(region);
        if (!archiveDb) {
          this.logger.debug(`No archive database configured for region ${region}, skipping.`);
          continue;
        }

        const db = this.knex.db(region);
        
        // Find orders older than current year
        const currentYear = new Date().getFullYear();
        const startOfThisYear = new Date(Date.UTC(currentYear, 0, 1));

        const countQuery = await db('orders')
          .where('created_at', '<', startOfThisYear)
          .count('id as cnt')
          .first();

        const count = Number(countQuery?.cnt || 0);
        this.logger.log(`Region ${region}: Found ${count} orders eligible for archival.`);
        
        // Full archival logic would process these orders in batches here
      } catch (err) {
        this.logger.error(`Archival failed for region ${region}: ${(err as Error).message}`);
      }
    }
  }
}
