import { config as loadDotenv } from 'dotenv';
import knexLib from 'knex';
import { applyCursorPagination } from '../src/lib/pagination/cursor-pagination';
loadDotenv();
async function main() {
  const r = 'eg';
  const k = knexLib({
    client: 'pg',
    connection: {
      host: process.env[`DB_${r}_HOST`]!,
      port: Number(process.env[`DB_${r}_PORT`]),
      user: process.env[`DB_${r}_USERNAME`]!,
      password: process.env[`DB_${r}_PASSWORD`] ?? '',
      database: process.env[`DB_${r}_NAME`]!,
    },
  });
  const cursor = '2026-05-08T20:54:13.098Z';
  const q = k('orders').select('public_id', 'created_at').where('customer_id', 5);
  const final = applyCursorPagination(q, {
    cursor,
    limit: 10,
    sortBy: 'created_at',
    apiSortBy: 'createdAt',
    sortOrder: 'desc',
  });
  console.log('SQL:', final.toString());
  const rows = await final;
  for (const row of rows)
    console.log('  ', row.public_id, '→', (row.created_at as Date).toISOString());
  await k.destroy();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
