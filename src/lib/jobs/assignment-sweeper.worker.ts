import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { ShardedKnex } from '../sharding/shards';
import { AssignmentService } from '../../app/order/assignment.service';

@Injectable()
export class AssignmentSweeperWorker {
  private readonly logger = new Logger(AssignmentSweeperWorker.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly assignmentService: AssignmentService,
  ) {}

  @Cron('*/10 * * * * *') // Every 10 seconds
  async sweepStaleAssignments() {
    this.logger.debug('Sweeping stale assignments...');

    for (const region of this.knex.regions()) {
      try {
        await this.assignmentService.performSweep(region);
      } catch (err) {
        this.logger.error(`Error sweeping assignments in region ${region}: ${(err as Error).message}`);
      }
    }
  }
}
