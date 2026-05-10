/**
 * Create monthly partitions for `orders` (and any future RANGE-by-month tables).
 *
 * Usage:
 *   npx ts-node play/create-partitions.ts                 # default 12 months ahead
 *   MONTHS_AHEAD=24 npx ts-node play/create-partitions.ts  # custom horizon
 *
 * Iterates every region in REGIONS env, connects to its hot cluster, and
 * creates partitions from the *first day of the current month* up to N
 * months ahead. Idempotent — uses CREATE TABLE IF NOT EXISTS so re-running
 * is a no-op once the window is in place.
 *
 * Run this manually (or wire into a monthly cron) so the rolling window
 * always extends past today. The migration only creates the parent +
 * default partition; the active month must exist before the first INSERT
 * for that month or rows fall through to `orders_default`.
 */
import { config as loadDotenv } from 'dotenv';
import knexLib, { Knex } from 'knex';

loadDotenv();

const PARTITIONED_TABLES = ['orders'] as const;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function partitionRange(d: Date): { name: (t: string) => string; from: string; to: string } {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const fromIso = `${year}-${pad(month)}-01`;
  const next = new Date(Date.UTC(year, month, 1));
  const toIso = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`;
  return {
    name: (t: string) => `${t}_y${year}m${pad(month)}`,
    from: fromIso,
    to: toIso,
  };
}

async function ensurePartitions(
  knex: Knex,
  region: string,
  monthsAhead: number,
): Promise<{ created: number; existed: number }> {
  let created = 0;
  let existed = 0;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  for (let i = 0; i < monthsAhead; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const { name, from, to } = partitionRange(d);
    for (const parent of PARTITIONED_TABLES) {
      const partName = name(parent);
      const exists = await knex.raw(
        `SELECT 1 FROM pg_class WHERE relname = ? LIMIT 1`,
        [partName],
      );
      if (exists.rowCount && exists.rowCount > 0) {
        existed++;
        continue;
      }
      await knex.raw(
        `CREATE TABLE ${partName} PARTITION OF ${parent}
         FOR VALUES FROM ('${from}') TO ('${to}');`,
      );
      created++;
      console.log(
        `[${region}] created partition ${partName}  (${from}  →  ${to})`,
      );
    }
  }
  return { created, existed };
}

function buildKnexForRegion(region: string): Knex {
  const host = process.env[`DB_${region}_HOST`];
  const port = process.env[`DB_${region}_PORT`];
  const user = process.env[`DB_${region}_USERNAME`];
  const password = process.env[`DB_${region}_PASSWORD`];
  const database = process.env[`DB_${region}_NAME`];
  if (!host || !port || !user || !database) {
    throw new Error(
      `Missing DB env for region "${region}" (need DB_${region}_HOST/PORT/USERNAME/PASSWORD/NAME).`,
    );
  }
  return knexLib({
    client: 'pg',
    connection: {
      host,
      port: Number(port),
      user,
      password: password ?? '',
      database,
    },
    pool: { min: 0, max: 2 },
  });
}

async function main() {
  const monthsAhead = Number(process.env.MONTHS_AHEAD ?? 12);
  if (!Number.isInteger(monthsAhead) || monthsAhead < 1) {
    throw new Error('MONTHS_AHEAD must be a positive integer');
  }
  const regions = (process.env.REGIONS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (regions.length === 0) {
    throw new Error('REGIONS env is empty (e.g. REGIONS=eg,ksa)');
  }

  console.log(`Ensuring ${monthsAhead} months of partitions across regions: ${regions.join(', ')}`);
  for (const region of regions) {
    const knex = buildKnexForRegion(region);
    try {
      const { created, existed } = await ensurePartitions(knex, region, monthsAhead);
      console.log(
        `[${region}] done — ${created} created, ${existed} already existed`,
      );
    } finally {
      await knex.destroy();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
