/**
 * DB inspector for order-service. No psql required.
 *
 *   npx ts-node play/inspect.ts                # default region from REGION env or first in REGIONS
 *   REGION=eg npx ts-node play/inspect.ts
 *
 * Prints:
 *   - tables in `public` schema
 *   - partition tree for `orders`
 *   - indexes on each parent + per-partition row counts
 *   - first row of orders + items (if any)
 *   - EXPLAIN for the three hot queries
 */
import { config as loadDotenv } from 'dotenv';
import knexLib from 'knex';

loadDotenv();

async function main() {
  const region =
    process.env.REGION ??
    (process.env.REGIONS ?? 'eg').split(',')[0].trim();
  const host = process.env[`DB_${region}_HOST`];
  const port = process.env[`DB_${region}_PORT`];
  const user = process.env[`DB_${region}_USERNAME`];
  const password = process.env[`DB_${region}_PASSWORD`];
  const database = process.env[`DB_${region}_NAME`];

  if (!host || !port || !user || !database) {
    console.error(`missing DB env for region "${region}"`);
    process.exit(1);
  }

  const knex = knexLib({
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

  try {
    console.log(`# region=${region} db=${database}`);

    console.log('\n## tables');
    const tables = await knex.raw(
      `SELECT relname FROM pg_class
       JOIN pg_namespace n ON n.oid=relnamespace
       WHERE n.nspname='public' AND relkind IN ('r','p')
       ORDER BY relname`,
    );
    for (const r of tables.rows) console.log(`  ${r.relname}`);

    console.log('\n## partition tree (orders)');
    const tree = await knex.raw(`SELECT * FROM pg_partition_tree('orders')`);
    for (const r of tree.rows) {
      console.log(
        `  ${r.relid.padEnd(24)} parent=${(r.parentrelid ?? '').padEnd(8)} leaf=${r.isleaf} level=${r.level}`,
      );
    }

    console.log('\n## indexes on orders (parent)');
    const idx = await knex.raw(
      `SELECT indexname FROM pg_indexes WHERE tablename='orders' ORDER BY indexname`,
    );
    for (const r of idx.rows) console.log(`  ${r.indexname}`);

    console.log('\n## per-partition row counts');
    const counts = await knex.raw(`
      SELECT child.relname AS partition,
             pg_total_relation_size(child.oid) AS bytes,
             (SELECT count(*) FROM ONLY pg_namespace) AS _ -- placeholder; row count via per-partition query below
      FROM pg_inherits i
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_class child  ON child.oid  = i.inhrelid
      WHERE parent.relname = 'orders'
      ORDER BY child.relname
    `);
    for (const r of counts.rows) {
      const row = await knex.raw(`SELECT count(*)::int AS n FROM ONLY ??`, [r.partition]);
      console.log(`  ${String(r.partition).padEnd(24)} rows=${row.rows[0].n} bytes=${r.bytes}`);
    }

    console.log('\n## sample row (latest order)');
    const latest = await knex('orders')
      .select(
        'id',
        'public_id',
        'status',
        'payment_method',
        'subtotal',
        'delivery_fee',
        'total',
        'currency',
        'created_at',
      )
      .orderBy('id', 'desc')
      .first();
    console.log(latest ?? '  (none)');

    if (latest) {
      const items = await knex('order_items')
        .select('id', 'product_id', 'quantity', 'unit_price_snapshot', 'line_total')
        .where('order_id', latest.id);
      console.log('\n## items for that order');
      for (const it of items) console.log(`  ${JSON.stringify(it)}`);
    }

    console.log('\n## EXPLAIN: GET /restaurant/orders branch+status');
    await explain(
      knex,
      `SELECT * FROM orders WHERE branch_id=1 AND status='ready' ORDER BY created_at DESC LIMIT 20`,
    );

    console.log('\n## EXPLAIN: GET /customer/orders year=now (range scoped → partition prune expected)');
    await explain(
      knex,
      `SELECT * FROM orders WHERE customer_id=5 AND created_at >= date_trunc('month', NOW()) AND created_at < date_trunc('month', NOW()) + INTERVAL '1 month' ORDER BY created_at DESC LIMIT 20`,
    );

    console.log('\n## EXPLAIN: GET /orders/:publicId');
    if (latest) {
      await explain(
        knex,
        `SELECT * FROM orders WHERE public_id='${latest.public_id}'`,
      );
    }
  } finally {
    await knex.destroy();
  }
}

async function explain(knex: ReturnType<typeof knexLib>, sql: string) {
  const { rows } = await knex.raw(`EXPLAIN ${sql}`);
  for (const r of rows) console.log(`  ${r['QUERY PLAN']}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
