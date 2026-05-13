/**
 * Phase 2 manual smoke test for /api/payments/*.
 *
 * Bypasses the OrderService.placeOrder code path (which requires a running
 * core-service) by inserting a synthetic order directly into the DB. Then:
 *
 *   1. POST /api/payments/init                 -> 200 with redirectUrl + sessionId
 *   2. POST /api/payments/init (replay)        -> domain idempotency: same session
 *   3. POST /api/payments/webhook/kashier      -> SUCCESS event flips order to placed
 *   4. POST /api/payments/webhook/kashier      -> duplicate is acked, no side effect
 *   5. GET  /api/payments/{txId}               -> charge details (admin)
 *   6. POST /api/payments/{txId}/refund        -> admin refund (creates pending tx)
 *   7. POST /api/payments/webhook/kashier      -> refund SUCCESS flips refund to succeeded
 *
 * Usage:
 *   npx ts-node play/test-payment-flow.ts
 */

import knex from 'knex';
import { config as loadEnv } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';
import * as jwt from 'jsonwebtoken';

loadEnv();

const BASE = 'http://localhost:4000';
const REGION = 'eg';

const KASHIER_API_KEY = process.env.KASHIER_API_KEY!;

function signCustomerToken(userId: number): string {
  return jwt.sign(
    { userId, role: 'customer' },
    process.env.ACCESS_SECRET!,
    { expiresIn: '1h' },
  );
}
function signAdminToken(): string {
  return jwt.sign(
    { userId: 1, role: 'system_admin' },
    process.env.ACCESS_SECRET!,
    { expiresIn: '1h' },
  );
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

function sigForData(data: any): string {
  const keys = [...(data.signatureKeys ?? [])].sort();
  const parts = keys.map(
    (k) =>
      `${encodeURIComponent(k)}=${encodeURIComponent(stringifyVal(data[k]))}`,
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
  const customerId = 5;
  const customerToken = signCustomerToken(customerId);
  const adminToken = signAdminToken();
  const cookies = `access_token=${customerToken}`;
  const adminCookies = `access_token=${adminToken}`;

  // ─── 1. seed a synthetic pending_payment online order ─────────────────────
  const publicId = uuidv4();
  const now = new Date();
  const [orderRow] = await k('orders')
    .insert({
      region: REGION,
      public_id: publicId,
      country_code: 'eg',
      restaurant_id: 1,
      branch_id: 1,
      customer_id: customerId,
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
  console.log(
    `seed: order id=${orderRow.id} public_id=${publicId} created_at=${orderRow.created_at}`,
  );

  // ─── 2. POST /api/payments/init ───────────────────────────────────────────
  const initRes = await fetchJson(`${BASE}/api/payments/init`, {
    method: 'POST',
    cookies,
    headers: { 'Idempotency-Key': `key-${publicId}-init-1` },
    body: JSON.stringify({ orderId: publicId }),
  });
  console.log(`init #1 -> ${initRes.status} ${initRes.text.slice(0, 240)}`);
  if (initRes.status !== 200 && initRes.status !== 201) {
    console.error('init failed; aborting');
    await k.destroy();
    process.exit(1);
  }
  const session = initRes.body.data;

  // ─── 3. POST /api/payments/init replay (HTTP-level idempotency) ──────────
  const initRes2 = await fetchJson(`${BASE}/api/payments/init`, {
    method: 'POST',
    cookies,
    headers: { 'Idempotency-Key': `key-${publicId}-init-1` },
    body: JSON.stringify({ orderId: publicId }),
  });
  console.log(
    `init #2 (same key) -> ${initRes2.status} ${initRes2.text.slice(0, 200)}`,
  );

  // ─── 4. simulate Kashier webhook (pay SUCCESS) ────────────────────────────
  const data = {
    merchantOrderId: publicId,
    kashierOrderId: `kshorder_${session.providerSessionId}`,
    transactionId: `tx_${session.providerSessionId}`,
    status: 'SUCCESS',
    method: 'card',
    amount: 165,
    currency: 'EGP',
    signatureKeys: [
      'amount',
      'currency',
      'merchantOrderId',
      'status',
      'transactionId',
    ],
  };
  const sig = sigForData(data);
  const webhookBody = { event: 'pay', data };

  const wh1 = await fetchJson(`${BASE}/api/payments/webhook/kashier`, {
    method: 'POST',
    headers: { 'x-kashier-signature': sig, 'X-Region': REGION },
    body: JSON.stringify(webhookBody),
  });
  console.log(`webhook pay #1 -> ${wh1.status} ${wh1.text.slice(0, 200)}`);

  // ─── 5. duplicate webhook ack ─────────────────────────────────────────────
  const wh2 = await fetchJson(`${BASE}/api/payments/webhook/kashier`, {
    method: 'POST',
    headers: { 'x-kashier-signature': sig, 'X-Region': REGION },
    body: JSON.stringify(webhookBody),
  });
  console.log(`webhook pay #2 (dup) -> ${wh2.status} ${wh2.text.slice(0, 200)}`);

  // verify DB state
  const orderAfter = await k('orders')
    .select('status', 'public_id')
    .where('id', orderRow.id)
    .first();
  console.log(`order.status after capture = ${orderAfter?.status}`);
  const charge = await k('transactions')
    .select('id', 'transaction_type', 'status', 'amount', 'provider_reference_id')
    .where({ order_id: orderRow.id, transaction_type: 'charge' })
    .first();
  console.log(`charge: ${JSON.stringify(charge)}`);

  // ─── 6. GET /api/payments/{id} (admin) ────────────────────────────────────
  if (charge) {
    const get1 = await fetchJson(`${BASE}/api/payments/${charge.id}`, {
      method: 'GET',
      cookies: adminCookies,
    });
    console.log(`get payment -> ${get1.status} ${get1.text.slice(0, 240)}`);
  }

  // ─── 7. POST refund (admin) ──────────────────────────────────────────────
  // NB: this issues a real PUT to test-fep.kashier.io with the txn id we made
  // up above. Kashier will return 4xx (unknown txn). We expect the order-
  // service to mark the refund row as `failed` and surface 503. That's still
  // a valid path for verifying the wiring; we then simulate a refund-success
  // webhook below to drive the happy path.
  if (charge) {
    const ref1 = await fetchJson(`${BASE}/api/payments/${charge.id}/refund`, {
      method: 'POST',
      cookies: adminCookies,
      headers: { 'Idempotency-Key': `key-${publicId}-refund-1` },
      body: JSON.stringify({ amount: 5000, reason: 'test refund' }),
    });
    console.log(`refund post -> ${ref1.status} ${ref1.text.slice(0, 240)}`);

    // Find the most recent refund row regardless of how the upstream call
    // resolved, so we can simulate the success webhook against it.
    const refundRow = await k('transactions')
      .where({ refunded_payment_id: charge.id, transaction_type: 'refund' })
      .orderBy('created_at', 'desc')
      .first();
    console.log(`refund row: ${JSON.stringify(refundRow)}`);

    if (refundRow) {
      const providerRef = refundRow.provider_reference_id ?? `simref_${refundRow.id}`;
      // make sure the row has a provider_reference_id we can correlate against
      if (!refundRow.provider_reference_id) {
        await k('transactions')
          .where('id', refundRow.id)
          .update({ provider_reference_id: providerRef });
      }
      const refundData = {
        merchantOrderId: publicId,
        transactionId: providerRef,
        status: 'SUCCESS',
        amount: refundRow.amount / 100,
        currency: refundRow.currency,
        signatureKeys: [
          'amount',
          'currency',
          'merchantOrderId',
          'status',
          'transactionId',
        ],
      };
      const refundSig = sigForData(refundData);
      const wh3 = await fetchJson(`${BASE}/api/payments/webhook/kashier`, {
        method: 'POST',
        headers: { 'x-kashier-signature': refundSig, 'X-Region': REGION },
        body: JSON.stringify({ event: 'refund', data: refundData }),
      });
      console.log(
        `webhook refund -> ${wh3.status} ${wh3.text.slice(0, 200)}`,
      );
      const finalRefund = await k('transactions')
        .select('id', 'status', 'provider_reference_id')
        .where('id', refundRow.id)
        .first();
      console.log(`final refund row: ${JSON.stringify(finalRefund)}`);
      const chargeAfter = await k('transactions')
        .select('id', 'is_refunded', 'refunded_payment_id')
        .where('id', charge.id)
        .first();
      console.log(`final charge: ${JSON.stringify(chargeAfter)}`);
    }
  }

  await k.destroy();
}

main().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
