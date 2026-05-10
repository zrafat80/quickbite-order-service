import knex, { Knex } from 'knex';
import type { ShardConfig } from '../config/app.config';

export interface ShardPing {
  region: string;
  cluster: 'hot' | 'archive';
  ok: boolean;
  error?: string;
}

/**
 * Resolver shape exposed under the `KNEX_CONNECTION` DI token. Future
 * repositories inject this and call `this.knex.db(region).transaction(...)`
 * — never a bare Knex. CLAUDE.md §8 documents this deviation from core.
 */
export interface ShardedKnex {
  db(region: string): Knex;
  dbArchive(region: string): Knex;
  pingAll(): Promise<ShardPing[]>;
  regions(): string[];
  destroyAll(): Promise<void>;
}

export interface BuildShardedKnexInput {
  hot: Record<string, ShardConfig>;
  archive: Record<string, ShardConfig>;
  poolMax: number;
  migrations: { directory: string; extension: string };
}

function buildPool(shard: ShardConfig, input: BuildShardedKnexInput): Knex.Config {
  return {
    client: 'pg',
    connection: {
      host: shard.host,
      port: shard.port,
      user: shard.username,
      password: shard.password,
      database: shard.name,
    },
    pool: { min: 0, max: input.poolMax },
    migrations: input.migrations,
  };
}

/**
 * Lazy pool factory. Connections are created on first use per (cluster, region)
 * so the API process doesn't open archive connections it never queries in dev.
 */
export function buildShardedKnex(input: BuildShardedKnexInput): ShardedKnex {
  const hotByRegion = new Map<string, Knex>();
  const archiveByRegion = new Map<string, Knex>();

  function getHot(region: string): Knex {
    let conn = hotByRegion.get(region);
    if (!conn) {
      const cfg = input.hot[region];
      if (!cfg) {
        throw new Error(`No hot shard configured for region "${region}"`);
      }
      conn = knex(buildPool(cfg, input));
      hotByRegion.set(region, conn);
    }
    return conn;
  }

  function getArchive(region: string): Knex {
    let conn = archiveByRegion.get(region);
    if (!conn) {
      const cfg = input.archive[region];
      if (!cfg) {
        throw new Error(`No archive shard configured for region "${region}"`);
      }
      conn = knex(buildPool(cfg, input));
      archiveByRegion.set(region, conn);
    }
    return conn;
  }

  async function pingOne(
    region: string,
    cluster: 'hot' | 'archive',
  ): Promise<ShardPing> {
    try {
      const conn = cluster === 'hot' ? getHot(region) : getArchive(region);
      await conn.raw('SELECT 1');
      return { region, cluster, ok: true };
    } catch (err) {
      return {
        region,
        cluster,
        ok: false,
        error: (err as Error).message,
      };
    }
  }

  return {
    db: getHot,
    dbArchive: getArchive,
    regions: () => Object.keys(input.hot),
    async pingAll(): Promise<ShardPing[]> {
      const out: ShardPing[] = [];
      for (const r of Object.keys(input.hot)) out.push(await pingOne(r, 'hot'));
      // Archive ping skipped if not configured — best-effort only.
      for (const r of Object.keys(input.archive)) {
        out.push(await pingOne(r, 'archive'));
      }
      return out;
    },
    async destroyAll(): Promise<void> {
      await Promise.all([...hotByRegion.values()].map((c) => c.destroy()));
      await Promise.all([...archiveByRegion.values()].map((c) => c.destroy()));
      hotByRegion.clear();
      archiveByRegion.clear();
    },
  };
}
