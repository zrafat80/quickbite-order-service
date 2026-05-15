import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { ShardedKnex } from '../sharding/shards';
import { AssignmentService } from '../../app/order/assignment.service';
import { PresenceService } from '../../app/presence/presence.service';
import { OrderStatus } from '../../app/order/enums';

@Injectable()
export class AssignmentSweeperWorker {
  private readonly logger = new Logger(AssignmentSweeperWorker.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly assignmentService: AssignmentService,
    private readonly presenceService: PresenceService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepStaleAssignments() {
    this.logger.debug('Sweeping stale assignments...');

    for (const region of this.knex.regions()) {
      try {
        const db = this.knex.db(region);

        // 1. Bulk Database Read
        const assignedOrders = await db('orders')
            .select('id', 'public_id', 'created_at', 'delivery_agent_id')
            .where('status', OrderStatus.ASSIGNED)
            .whereNotNull('delivery_agent_id');

        if (assignedOrders.length === 0) continue;

        // 2. BULK REDIS READ (Fixing the N+1 Bug)
        // Get all unique agent IDs and fetch their meta in ONE network call
        const agentIds = [...new Set(assignedOrders.map((o) => Number(o.delivery_agent_id)))];
        const metaMap = await this.presenceService.getAgentsMeta(region, agentIds);

        const now = Date.now();
        const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

        // 3. FAST LOCAL FILTERING (No network calls in this loop)
        const staleOrders = assignedOrders.filter((order) => {
          const agentId = Number(order.delivery_agent_id);
          const presence = metaMap.get(agentId);

          if (!presence || !presence.isOnline) return true; // Dead/Offline
          return (now - presence.lastSeenAt) > STALE_THRESHOLD_MS; // Stale Heartbeat
        });

        if (staleOrders.length === 0) continue;
        this.logger.warn(`Found ${staleOrders.length} stale assignments in ${region}. Reassigning...`);

        // 4. SEQUENTIAL REASSIGNMENT (Safe Writes)
        // We do this one by one to avoid deadlocks and ensure proper DB locks
        for (const order of staleOrders) {
          const agentId = Number(order.delivery_agent_id);
          try {
            // This method handles the heavy lifting safely (Locks, Rejects, Redis cleanup)
            await this.assignmentService.handleAgentReject(
                region,
                Number(order.id),
                order.created_at,
                agentId,
            );
          } catch (err) {
            this.logger.error(`Failed to reassign stale order ${order.public_id}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        this.logger.error(`Error sweeping assignments in region ${region}: ${(err as Error).message}`);
      }
    }
  }
}
