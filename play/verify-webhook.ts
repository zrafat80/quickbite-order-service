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
  const publicId = 'b678d94d-1b42-49aa-943b-0d59f3d2d23b';
  const order = await k('orders').select('*').where('public_id', publicId).first();
  const session = await k('payment_sessions')
    .where('order_id', order.id)
    .orderBy('id', 'desc')
    .first();
  const charge = await k('transactions')
    .where({ order_id: order.id, transaction_type: 'charge' })
    .first();
  const events = await k('payment_webhook_events')
    .whereRaw("payload->'data'->>'merchantOrderId' = ?", [publicId])
    .orderBy('id', 'desc');
  console.log('order:', {
    id: order.id, public_id: order.public_id, status: order.status,
    total: order.total, currency: order.currency, payment_method: order.payment_method,
  });
  console.log('session:', {
    id: session?.id, status: session?.status,
    provider_session_id: session?.provider_session_id,
  });
  console.log('charge:', {
    id: charge?.id, status: charge?.status, amount: charge?.amount,
    currency: charge?.currency, provider_reference_id: charge?.provider_reference_id,
    method: charge?.method, idempotency_key: charge?.idempotency_key,
  });
  console.log('webhook events:');
  for (const e of events) {
    console.log('  ', {
      id: e.id, event_type: e.event_type, processed_at: e.processed_at,
      received_at: e.received_at, sig_first8: (e.signature || '').slice(0, 8),
      provider_event_id: e.provider_event_id,
    });
  }
  await k.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
