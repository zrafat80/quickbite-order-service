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
  const cols = await k('information_schema.columns')
    .select('column_name')
    .where({ table_name: 'transactions' })
    .whereIn('column_name', ['provider_reference_id', 'provider_order_id']);
  console.log(cols);
  await k.destroy();
})();
