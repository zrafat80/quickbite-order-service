import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { ShardedKnex } from "../sharding/shards";
import { AssignmentService } from "../../app/order/assignment.service";

@Injectable()
export class AssignmentSweeperWorker {
  private readonly logger = new Logger(AssignmentSweeperWorker.name);
  private running = false;

  constructor(
    @Inject("KNEX_CONNECTION") private readonly knex: ShardedKnex,
    private readonly assignmentService: AssignmentService,
    private readonly configService: ConfigService,
  ) {}

  @Cron("*/10 * * * * *") // Every 10 seconds
  async sweepStaleAssignments() {
    if (
      !this.configService.get<boolean>("deliveries.assignmentSweeperEnabled")
    ) {
      return;
    }

    if (this.running) {
      this.logger.warn(
        "Skipping assignment sweep because the previous sweep is still running.",
      );
      return;
    }

    this.running = true;
    this.logger.debug("Sweeping stale assignments...");

    try {
      for (const region of this.knex.regions()) {
        try {
          await this.assignmentService.performSweep(region);
        } catch (err) {
          this.logger.error(
            `Error sweeping assignments in region ${region}: ${(err as Error).message}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
