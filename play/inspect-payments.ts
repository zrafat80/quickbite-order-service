import knex from 'knex';
import { config } from 'dotenv';
config();

async function main() {
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
  try {
    const tables = await k.raw(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
    );
    console.log('TABLES:', tables.rows.map((r: any) => r.table_name).join(', '));

    const providers = await k('payment_providers').select('*').orderBy('id');
    console.log('PROVIDERS:', JSON.stringify(providers));

    const cols = await k.raw(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='transactions' ORDER BY ordinal_position`,
    );
    console.log('transactions cols:', cols.rows.length);
  } finally {
    await k.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
