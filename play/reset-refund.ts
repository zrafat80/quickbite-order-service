import knex from 'knex';
import { config as loadEnv } from 'dotenv';
loadEnv();
(async () => {
  const k = knex({
    client: 'pg',
    connection: {
      host: process.env.DB_eg_HOST,
      port: Number(process.env.DB_eg_PORT),
      user: process.env.DB_eg_USERNAME,
      password: process.env.DB_eg_PASSWORD,
      database: process.env.DB_eg_NAME,
    },
  });
  const n = await k('transactions').where({ id: 28, status: 'failed' }).del();
  console.log(`deleted ${n} failed refund row(s)`);
  await k.destroy();
})();
