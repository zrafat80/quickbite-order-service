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
  const ORDER_ID = 52;
  const PUBLIC_ID = 'de5bdbac-a0b4-46b6-8c95-2a05b59e2e14';
  const PROVIDER_SESSION = '6a01e571d58c12d8ccabb522';

  const order = await k('orders')
    .select(['id', 'public_id', 'status', 'cancelled_at', 'created_at'])
    .where('id', ORDER_ID)
    .first();
  console.log('order:', order);

  const session = await k('payment_sessions')
    .select(['id', 'status', 'expires_at', 'provider_session_id'])
    .where('provider_session_id', PROVIDER_SESSION)
    .first();
  console.log('session:', session);

  const charges = await k('transactions')
    .select(['id', 'transaction_type', 'status', 'amount', 'provider_reference_id'])
    .where('order_id', ORDER_ID);
  console.log('transactions:', charges);

  const events = await k('payment_webhook_events')
    .select(['id', 'event_type', 'received_at', 'processed_at', 'process_error', 'provider_event_id'])
    .orderBy('received_at', 'desc')
    .limit(8);
  console.log('latest webhook events:', events);

  const eventsForOrder = await k('payment_webhook_events')
    .select(['id', 'event_type', 'received_at', 'processed_at', 'process_error'])
    .whereRaw("payload::text ILIKE ?", [`%${PUBLIC_ID}%`]);
  console.log(`webhook events mentioning ${PUBLIC_ID}:`, eventsForOrder);

  await k.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
