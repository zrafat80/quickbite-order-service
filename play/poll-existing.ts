/**
 * Re-poll for an order whose Kashier session was already created.
 * Used when the previous poller timed out before the user paid.
 */
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

  console.log(`polling order ${ORDER_ID} (${PUBLIC_ID}) for up to 5 min…`);
  const deadline = Date.now() + 5 * 60 * 1000;
  let webhookSeen = false;
  let lastStatus = 'pending_payment';
  let pollNo = 0;
  while (Date.now() < deadline) {
    pollNo++;
    await new Promise((r) => setTimeout(r, 2000));
    const ev = await k('payment_webhook_events')
      .whereRaw("payload::text ILIKE ?", [`%${PUBLIC_ID}%`])
      .orderBy('received_at', 'desc');
    const order = await k('orders').select('status').where('id', ORDER_ID).first();
    const charge = await k('transactions')
      .where({ order_id: ORDER_ID, transaction_type: 'charge' })
      .first();
    if (order && order.status !== lastStatus) {
      console.log(`[poll ${pollNo}] order.status -> ${order.status}`);
      lastStatus = order.status;
    }
    if (ev.length > 0 && !webhookSeen) {
      webhookSeen = true;
      console.log(`[poll ${pollNo}] received ${ev.length} webhook event(s):`);
      for (const e of ev) {
        console.log(
          `   id=${e.id} event=${e.event_type} processed_at=${e.processed_at ?? 'NULL'} err=${e.process_error ?? '-'}`,
        );
      }
    }
    if (webhookSeen && charge && order && (order.status === 'placed' || order.status === 'cancelled')) {
      console.log('');
      console.log('FINAL:');
      console.log(`  order status      = ${order.status}`);
      console.log(`  charge id=${charge.id} status=${charge.status} amount=${charge.amount} ${charge.currency} provider_ref=${charge.provider_reference_id}`);
      const items = await k('order_items').where({ order_id: ORDER_ID });
      console.log(`  order_items count = ${items.length}`);
      const refund = await k('transactions')
        .where({ order_id: ORDER_ID, transaction_type: 'refund' })
        .first();
      if (refund) {
        console.log(`  refund row id=${refund.id} status=${refund.status} amount=${refund.amount}`);
      }
      break;
    }
  }
  if (!webhookSeen) {
    console.log('TIMEOUT — still no webhook received.');
  }
  await k.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
