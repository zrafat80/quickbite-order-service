/**
 * Real-Kashier webhook smoke test (paired with `ngrok http 4000`).
 *
 * 1. Seed a synthetic pending_payment online order in the eg shard.
 * 2. POST /api/payments/init with a customer JWT cookie.
 * 3. Print the Kashier redirect URL — open it in a browser and pay with a
 *    Kashier test card. Kashier will POST to KASHIER_SERVER_WEBHOOK (set in
 *    .env to the ngrok URL).
 * 4. Poll the DB every 2s for up to 5 minutes; report when the webhook lands
 *    (payment_webhook_events row + order.status flip + transactions.charge).
 *
 * Usage:  npx ts-node play/test-webhook-ngrok.ts
 */

import knex from 'knex';
import { config as loadEnv } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import * as jwt from 'jsonwebtoken';

loadEnv();

const BASE = 'http://localhost:4000';
const REGION = 'eg';

function signCustomerToken(userId: number): string {
  return jwt.sign({ userId, role: 'customer' }, process.env.ACCESS_SECRET!, {
    expiresIn: '1h',
  });
}

async function fetchJson(
  url: string,
  init: RequestInit & { cookies?: string } = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Region': REGION,
    ...((init.headers as Record<string, string>) || {}),
  };
  if (init.cookies) headers['Cookie'] = init.cookies;
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

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

  const customerId = 5;
  const cookies = `access_token=${signCustomerToken(customerId)}`;

  // ─── 1. seed an online pending_payment order ────────────────────────────────
  // Real products from core-service: branch_id=1 → restaurant_id=3,
  // productId=1 (Double Smash) @ 2500 minor units, plenty of stock.
  // Including a real order_items row lets reserveStock succeed post-capture,
  // so the order ends in `placed` (not auto-cancelled by Phase B).
  const publicId = uuidv4();
  const [orderRow] = await k('orders')
    .insert({
      region: REGION,
      public_id: publicId,
      country_code: 'eg',
      restaurant_id: 3,
      branch_id: 1,
      customer_id: customerId,
      customer_address_id: 1,
      delivery_lat: 30.0444,
      delivery_lng: 31.2357,
      delivery_address_text_snapshot: '12 Test St, Cairo, EG',
      status: 'pending_payment',
      subtotal: 2500,
      delivery_fee: 1500,
      service_fee: 0,
      total: 4000,
      currency: 'EGP',
      payment_method: 'online',
    })
    .returning(['id', 'created_at']);
  await k('order_items').insert({
    region: REGION,
    order_id: orderRow.id,
    order_created_at: orderRow.created_at,
    product_id: 1,
    quantity: 1,
    unit_price_snapshot: 2500,
    name_snapshot: 'Double Smash',
    line_total: 2500,
  });
  console.log(
    `seed: order id=${orderRow.id} public_id=${publicId} total=40.00 EGP (1x Double Smash + delivery)`,
  );

  // ─── 2. POST /api/payments/init ─────────────────────────────────────────────
  const initRes = await fetchJson(`${BASE}/api/payments/init`, {
    method: 'POST',
    cookies,
    headers: { 'Idempotency-Key': `key-${publicId}-init-1` },
    body: JSON.stringify({ orderId: publicId }),
  });
  console.log(`init -> ${initRes.status}`);
  if (initRes.status !== 200 && initRes.status !== 201) {
    console.error(`init failed: ${initRes.text}`);
    await k.destroy();
    process.exit(1);
  }
  const session = initRes.body.data;
  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log(' OPEN THIS URL IN A BROWSER AND PAY WITH A KASHIER TEST CARD');
  console.log('────────────────────────────────────────────────────────────');
  console.log(` ${session.redirectUrl}`);
  console.log('');
  console.log(' Kashier sandbox test card (success):');
  console.log('   number  : 5123 4500 0000 0008');
  console.log('   expiry  : 05/29');
  console.log('   cvv     : 100');
  console.log('   3DS OTP : 1234 (if prompted)');
  console.log(`   provider session: ${session.providerSessionId}`);
  console.log(`   merchant order  : ${publicId}`);
  console.log('────────────────────────────────────────────────────────────');
  console.log('');

  // ─── 3. poll DB for the real webhook ───────────────────────────────────────
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min
  let webhookSeen = false;
  let lastStatus = 'pending_payment';
  let pollNo = 0;
  while (Date.now() < deadline) {
    pollNo++;
    await new Promise((r) => setTimeout(r, 2000));
    const ev = await k('payment_webhook_events')
      .where({ region: REGION })
      .andWhereRaw("payload->'data'->>'merchantOrderId' = ?", [publicId])
      .orderBy('received_at', 'desc')
      .limit(5);
    const order = await k('orders')
      .select('status')
      .where('id', orderRow.id)
      .first();
    const charge = await k('transactions')
      .where({ order_id: orderRow.id, transaction_type: 'charge' })
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
          `   id=${e.id} event=${e.event_type} processed_at=${e.processed_at ?? 'NULL'} err=${e.error_message ?? '-'}`,
        );
      }
    }
    if (webhookSeen && charge && order && order.status === 'placed') {
      console.log('');
      console.log('SUCCESS — webhook captured, order placed, charge written:');
      console.log(
        `  charge id=${charge.id} status=${charge.status} amount=${charge.amount} ${charge.currency} provider_ref=${charge.provider_reference_id}`,
      );
      console.log(`  order ${publicId} -> ${order.status}`);
      break;
    }
  }
  if (!webhookSeen) {
    console.log('TIMEOUT — no webhook received after 5 minutes.');
    console.log('Things to check:');
    console.log(`  - ngrok tunnel is still up:  curl http://localhost:4040/api/tunnels`);
    console.log('  - dev server log: tail play/logs/dev.log');
    console.log('  - ngrok requests:  http://localhost:4040  (Inspect tab)');
  }

  await k.destroy();
}

main().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
