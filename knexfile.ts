import { config as loadDotenv } from 'dotenv';
import type { Knex } from 'knex';

loadDotenv();

/**
 * Builds a knex config for the region+cluster identified by env vars.
 *   REGION=eg|ksa|...    (required — never default, so migrations can't silently
 *                          run against the wrong shard)
 *   CLUSTER=hot|archive  (defaults to "hot")
 *
 * Drives `npm run migrate`, `migrate:rollback`, etc. The per-process shard
 * connections used by the running app come from src/lib/sharding/shards.ts.
 */
const region = process.env.REGION;
if (!region) {
  throw new Error(
    'REGION env var is required (e.g. `REGION=eg npm run migrate`).',
  );
}

const cluster = (process.env.CLUSTER ?? 'hot') as 'hot' | 'archive';
const prefix = cluster === 'hot' ? 'DB' : 'ARCHIVE_DB';

const host = process.env[`${prefix}_${region}_HOST`];
const port = process.env[`${prefix}_${region}_PORT`];
const user = process.env[`${prefix}_${region}_USERNAME`];
const password = process.env[`${prefix}_${region}_PASSWORD`];
const database = process.env[`${prefix}_${region}_NAME`];

if (!host || !port || !user || !database) {
  throw new Error(
    `Missing ${prefix} env for region "${region}". Expected ${prefix}_${region}_HOST/PORT/USERNAME/PASSWORD/NAME.`,
  );
}

const isProduction = process.env.NODE_ENV === 'production';

const config: Knex.Config = {
  client: 'pg',
  connection: {
    host,
    port: Number(port),
    user,
    password: password ?? '',
    database,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  },
  pool: {
    min: 0,
    max: Number(process.env.DB_POOL_MAX ?? 10),
  },
  migrations: {
    directory: isProduction
      ? './dist/database/migrations'
      : './src/database/migrations',
    extension: isProduction ? 'js' : 'ts',
  },
};

export default config;
