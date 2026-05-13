/**
 * Phase B test: webhook capture + reserveStock fail → auto-cancel + auto-refund.
 *
 * 1. Seed a synthetic pending_payment online order + a payment_sessions row
 *    + an order_items row pointing to a non-existent product so the
 *    branchClient.reserveStock call returns {ok: false}.
 * 2. POST a self-signed Kashier-style webhook (pay/SUCCESS) to flip the
 *    order to placed and insert a succeeded charge.
 * 3. Wait for the post-commit settlement to run reserveStock → fail →
 *    auto-cancel the order → systemRefundCharge.
 * 4. Verify: order.status = cancelled, transactions has 1 succeeded charge
 *    + 1 refund row (pending or failed — Kashier will 4xx the refund call
 *    because we used a fake transactionId, but the row should be there).
 */
import knex from 'knex';
import { config as loadEnv } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';
loadEnv();

const BASE = 'http://localhost:4000';
const REGION = 'eg';
const KASHIER_API_KEY = process.env.KASHIER_API_KEY!;

function sigForData(data: any): string {
  const keys = [...(data.signatureKeys ?? [])].sort();
  const parts = keys.map(
    (k) => `${encodeURIComponent(k)}=${encodeURIComponent(stringifyVal(data[k]))}`,
  );
  return createHmac('sha256', KASHIER_API_KEY)
    .update(parts.join('&'))
    .digest('hex');
}
function stringifyVal(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
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

  // ─── seed order + items + session ─────────────────────────────────────────
  const publicId = uuidv4();
  const [orderRow] = await k('orders')
    .insert({
      region: REGION,
      public_id: publicId,
      country_code: 'eg',
      restaurant_id: 1,
      branch_id: 1,
      customer_id: 5,
      customer_address_id: 1,
      delivery_lat: 30.0444,
      delivery_lng: 31.2357,
      delivery_address_text_snapshot: '12 Test St, Cairo, EG',
      status: 'pending_payment',
      subtotal: 15000,
      delivery_fee: 1500,
      service_fee: 0,
      total: 16500,
      currency: 'EGP',
      payment_method: 'online',
    })
    .returning(['id', 'created_at']);
  console.log(`order seeded: id=${orderRow.id} public=${publicId}`);

  await k('order_items').insert({
    region: REGION,
    order_id: orderRow.id,
    order_created_at: orderRow.created_at,
    product_id: 99999, // fictitious -> reserveStock returns insufficient
    quantity: 1,
    unit_price_snapshot: 15000,
    name_snapshot: 'phantom product',
    image_url_snapshot: null,
    line_total: 15000,
  });

  const fakeProviderSession = `kshorder_test_${Date.now()}`;
  await k('payment_sessions').insert({
    region: REGION,
    order_id: orderRow.id,
    order_created_at: orderRow.created_at,
    provider_id: 2,
    provider_session_id: fakeProviderSession,
    redirect_url: 'https://kashier.test/session',
    amount: 16500,
    currency: 'EGP',
    status: 'initialized',
    raw_init_payload: { test: true },
    expires_at: new Date(Date.now() + 5 * 60 * 1000),
  });

  // ─── webhook (pay/SUCCESS) ─────────────────────────────────────────────────
  const data = {
    merchantOrderId: publicId,
    kashierOrderId: `kshorder_${fakeProviderSession}`,
    transactionId: `tx_test_${orderRow.id}`,
    status: 'SUCCESS',
    method: 'card',
    amount: 165,
    currency: 'EGP',
    signatureKeys: ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'],
  };
  const sig = sigForData(data);
  const res = await fetch(`${BASE}/api/payments/webhook/kashier`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Region': REGION,
      'x-kashier-signature': sig,
    },
    body: JSON.stringify({ event: 'pay', data }),
  });
  console.log(`webhook -> ${res.status} ${(await res.text()).slice(0, 200)}`);

  // ─── poll for settlement (post-commit work runs async) ─────────────────────
  let order: any;
  let charge: any;
  let refund: any;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    order = await k('orders')
      .select('status', 'cancelled_at')
      .where('id', orderRow.id)
      .first();
    charge = await k('transactions')
      .where({ order_id: orderRow.id, transaction_type: 'charge' })
      .orderBy('id', 'desc')
      .first();
    refund = await k('transactions')
      .where({ order_id: orderRow.id, transaction_type: 'refund' })
      .orderBy('id', 'desc')
      .first();
    if (order.status === 'cancelled' && charge && refund) break;
  }
  console.log('order:', order);
  console.log('charge:', charge && {
    id: charge.id, status: charge.status, amount: charge.amount,
    provider_ref: charge.provider_reference_id,
  });
  console.log('refund:', refund && {
    id: refund.id, status: refund.status, amount: refund.amount,
    is_refunded_link: refund.refunded_payment_id,
  });

  const failures: string[] = [];
  if (!order || order.status !== 'cancelled') failures.push(`order.status expected cancelled, got ${order?.status}`);
  if (!charge) failures.push('charge row not created');
  if (charge && charge.status !== 'succeeded') failures.push(`charge.status expected succeeded, got ${charge.status}`);
  if (!refund) failures.push('refund row not created');
  if (refund && refund.refunded_payment_id !== charge?.id) {
    failures.push(`refund.refunded_payment_id expected ${charge?.id}, got ${refund?.refunded_payment_id}`);
  }
  if (failures.length === 0) {
    console.log('\nPASS — auto-cancel + auto-refund pipeline works');
    process.exit(0);
  }
  console.log('\nFAIL:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
main().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
