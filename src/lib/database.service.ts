import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ShardedKnex } from './sharding/shards';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
  ) {}

  async onApplicationShutdown(signal?: string) {
    this.logger.log(
      `Received ${signal}. Destroying all per-region pools (hot + archive)…`,
    );
    try {
      await this.knex.destroyAll();
      this.logger.log('All shard pools closed.');
    } catch (error) {
      this.logger.error('Error while closing shard pools', error as Error);
    }
  }
}
