// Throwaway: clear undispatched outbox rows so a fresh E2E starts clean.
import knex from 'knex';
import { config as loadDotenv } from 'dotenv';
loadDotenv();
async function main() {
  const db = knex({
    client: 'pg',
    connection: {
      host: process.env.DB_eg_HOST,
      port: Number(process.env.DB_eg_PORT),
      user: process.env.DB_eg_USERNAME,
      password: process.env.DB_eg_PASSWORD,
      database: process.env.DB_eg_NAME,
    },
  });
  const n = await db('events_outbox').del();
  console.log('deleted outbox rows:', n);
  await db.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
