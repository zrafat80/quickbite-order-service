import knex from 'knex';
import { config as loadEnv } from 'dotenv';
loadEnv();

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
  // The capture webhook for our live order had id=27. Check payload shape.
  const ev = await k('payment_webhook_events').where('id', 27).first();
  console.log('event_type:', ev?.event_type);
  console.log('signature :', ev?.signature?.slice(0, 12) + '…');
  console.log('payload   :', JSON.stringify(ev?.payload, null, 2));
  await k.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
