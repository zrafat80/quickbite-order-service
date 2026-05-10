import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { ShardConfig } from './config/app.config';
import { buildShardedKnex } from './sharding/shards';

/**
 * `KNEX_CONNECTION` resolves to a `ShardedKnex` resolver, NOT a raw Knex.
 * Repositories inject it as `@Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex`
 * and call `this.knex.db(region).transaction(...)`. CLAUDE.md §8 documents
 * the deviation from core-service's single-connection model.
 *
 * Pools are built lazily on first call — boot does not open a pool per
 * region/cluster, so a missing archive cluster in dev does not crash the API.
 */
export const databaseProviders = [
  {
    provide: 'KNEX_CONNECTION',
    inject: [ConfigService],
    useFactory: (configService: ConfigService) => {
      const logger = new Logger('DatabaseProvider');
      const hot = configService.get<Record<string, ShardConfig>>('hotShards') ?? {};
      const archive =
        configService.get<Record<string, ShardConfig>>('archiveShards') ?? {};
      const poolMax = configService.get<number>('db.poolMax') ?? 10;
      const migrations = {
        directory:
          configService.get<string>('db.migrationDirectory') ??
          'src/database/migrations',
        extension: configService.get<string>('db.migrationExtension') ?? 'ts',
      };

      const sharded = buildShardedKnex({ hot, archive, poolMax, migrations });

      logger.log(
        `Sharded Knex resolver ready (hot regions: ${Object.keys(hot).join(',') || 'none'}, archive regions: ${Object.keys(archive).join(',') || 'none'}).`,
      );

      return sharded;
    },
  },
];
