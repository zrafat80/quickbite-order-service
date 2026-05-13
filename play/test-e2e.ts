/**
 * End-to-end test suite for the order + payment flows.
 *
 * Runs against the LIVE dev stack:
 *   - order-service on :4000
 *   - core-service on :3000 (reserveStock for real)
 *   - postgres (eg shard), redis
 *
 * Scenarios:
 *   S1  online happy path: init -> simulated webhook capture -> stock reserved
 *       (productId=1) -> order=placed, charge=succeeded
 *   S2  online init replay (same Idempotency-Key) -> same session
 *   S3  online + capture but order_items references a missing productId ->
 *       reserveStock fails -> order auto-cancelled + refund row created
 *   S4  webhook pay/FAILED -> session=failed, order stays in pending_payment
 *   S5  webhook duplicate delivery (same eventId) -> acked, no side effect
 *   S6  webhook bad signature -> 401
 *   S7  webhook unknown merchantOrderId (valid sig) -> 200 silent
 *   S8  init for non-existent order -> 404
 *   S9  init for already-placed order -> 409
 *   S10 sweeper: abandoned online order past grace window -> cancelled,
 *       session->expired
 *   S11 sweeper: active session within grace -> untouched
 *   S12 sweeper: already-placed order -> untouched
 *   S13 admin refund flow: refund row created + refund webhook flips it to
 *       succeeded
 *   S14 GET /payments/:id authz: admin=200, customer=403,
 *       owner-restaurant=200, wrong-restaurant=403
 *
 * Usage:
 *   npx ts-node play/test-e2e.ts
 */

import knex from 'knex';
import { config as loadEnv } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';
import * as jwt from 'jsonwebtoken';

loadEnv();

const BASE = 'http://localhost:4000';
const REGION = 'eg';

// Real data already seeded in core-service.
const BRANCH_ID = 1;
const RESTAURANT_ID = 3;
const REAL_PRODUCT_ID = 1; // Double Smash, price 2500, stock ~98
const MISSING_PRODUCT_ID = 99999;
const CUSTOMER_ID = 5;
const CUSTOMER_ADDRESS_ID = 1;

// PaymentSessionSweeperWorker grace window comes from env.
const GRACE_MIN = Number(process.env.PAYMENT_SESSION_TIMEOUT_MIN ?? 15);

const KASHIER_API_KEY = process.env.KASHIER_API_KEY!;
const ACCESS_SECRET = process.env.ACCESS_SECRET!;

type Result = { name: string; pass: boolean; details: string };
const results: Result[] = [];
function record(name: string, pass: boolean, details = '') {
  results.push({ name, pass, details });
  const marker = pass ? 'PASS' : 'FAIL';
  console.log(`[${marker}] ${name}${details ? ' :: ' + details : ''}`);
}

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '1h' });
}

function customerCookie(userId = CUSTOMER_ID): string {
  return `access_token=${signToken({ userId, role: 'customer' })}`;
}
function adminCookie(): string {
  return `access_token=${signToken({ userId: 1, role: 'system_admin' })}`;
}
function restaurantUserCookie(restaurantId: number): string {
  return `access_token=${signToken({
    userId: 100 + restaurantId,
    role: 'restaurant_user',
    restaurantId,
    restaurantRole: 'owner',
    branchIds: [BRANCH_ID],
  })}`;
}

async function http(
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

function stringifyVal(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
function signKashier(data: any): string {
  const keys = [...(data.signatureKeys ?? [])].sort();
  const parts = keys.map(
    (k) =>
      `${encodeURIComponent(k)}=${encodeURIComponent(stringifyVal(data[k]))}`,
  );
  return createHmac('sha256', KASHIER_API_KEY)
    .update(parts.join('&'))
    .digest('hex');
}

type SeededOrder = {
  id: number;
  publicId: string;
  createdAt: Date;
};

async function seedOrder(
  k: ReturnType<typeof knex>,
  opts: {
    status?: string;
    paymentMethod?: 'online' | 'cod';
    productId?: number;
    quantity?: number;
    ageMinutes?: number;
  } = {},
): Promise<SeededOrder> {
  const status = opts.status ?? 'pending_payment';
  const paymentMethod = opts.paymentMethod ?? 'online';
  const productId = opts.productId ?? REAL_PRODUCT_ID;
  const quantity = opts.quantity ?? 1;
  const ageMinutes = opts.ageMinutes ?? 0;
  const publicId = uuidv4();
  const createdAt = new Date(Date.now() - ageMinutes * 60_000);
  const subtotal = 2500 * quantity;
  const deliveryFee = 1500;
  const total = subtotal + deliveryFee;
  const [orderRow] = await k('orders')
    .insert({
      region: REGION,
      public_id: publicId,
      country_code: 'eg',
      restaurant_id: RESTAURANT_ID,
      branch_id: BRANCH_ID,
      customer_id: CUSTOMER_ID,
      customer_address_id: CUSTOMER_ADDRESS_ID,
      delivery_lat: 30.0444,
      delivery_lng: 31.2357,
      delivery_address_text_snapshot: '12 Test St, Cairo, EG',
      status,
      subtotal,
      delivery_fee: deliveryFee,
      service_fee: 0,
      total,
      currency: 'EGP',
      payment_method: paymentMethod,
      created_at: createdAt,
      updated_at: createdAt,
    })
    .returning(['id', 'created_at']);
  await k('order_items').insert({
    region: REGION,
    order_id: orderRow.id,
    order_created_at: orderRow.created_at,
    product_id: productId,
    quantity,
    unit_price_snapshot: 2500,
    name_snapshot: productId === REAL_PRODUCT_ID ? 'Double Smash' : 'Synthetic',
    line_total: 2500 * quantity,
  });
  return {
    id: Number(orderRow.id),
    publicId,
    createdAt: orderRow.created_at,
  };
}

async function captureSimulated(
  publicId: string,
  providerSessionId: string,
  amountMinor: number,
): Promise<{ status: number; body: any }> {
  const data = {
    merchantOrderId: publicId,
    kashierOrderId: `ks_${providerSessionId}`,
    transactionId: `tx_${providerSessionId}_${Date.now()}`,
    status: 'SUCCESS',
    method: 'card',
    amount: amountMinor / 100,
    currency: 'EGP',
    signatureKeys: [
      'amount',
      'currency',
      'merchantOrderId',
      'status',
      'transactionId',
    ],
  };
  const sig = signKashier(data);
  return http(`${BASE}/api/payments/webhook/kashier`, {
    method: 'POST',
    headers: { 'x-kashier-signature': sig },
    body: JSON.stringify({ event: 'pay', data }),
  });
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 8000,
  intervalMs = 250,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
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

  // ────── S1: happy online flow ────────────────────────────────────────────
  try {
    const o = await seedOrder(k, { productId: REAL_PRODUCT_ID, quantity: 1 });
    const init = await http(`${BASE}/api/payments/init`, {
      method: 'POST',
      cookies: customerCookie(),
      headers: { 'Idempotency-Key': `${o.publicId}-init` },
      body: JSON.stringify({ orderId: o.publicId }),
    });
    if (![200, 201].includes(init.status)) {
      record('S1 online happy path', false, `init -> ${init.status}`);
    } else {
      const wh = await captureSimulated(
        o.publicId,
        init.body.data.providerSessionId,
        2500 + 1500,
      );
      if (wh.status !== 200) {
        record('S1 online happy path', false, `webhook -> ${wh.status}`);
      } else {
        // Settlement runs post-commit; wait for reserveStock to succeed and
        // order to remain in `placed`.
        const final = await waitFor(async () => {
          const row = await k('orders')
            .select('status')
            .where('id', o.id)
            .first();
          if (!row) return null;
          if (row.status === 'placed' || row.status === 'cancelled') return row;
          return null;
        });
        const charge = await k('transactions')
          .select('id', 'status', 'transaction_type')
          .where({ order_id: o.id, transaction_type: 'charge' })
          .first();
        const ok =
          final?.status === 'placed' &&
          charge?.status === 'succeeded';
        record(
          'S1 online happy path',
          ok,
          `order=${final?.status} charge=${charge?.status ?? 'none'}`,
        );
      }
    }
  } catch (err) {
    record('S1 online happy path', false, (err as Error).message);
  }

  // ────── S2: init replay (idempotency) ────────────────────────────────────
  try {
    const o = await seedOrder(k, { productId: REAL_PRODUCT_ID, quantity: 1 });
    const key = `${o.publicId}-init`;
    const a = await http(`${BASE}/api/payments/init`, {
      method: 'POST',
      cookies: customerCookie(),
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ orderId: o.publicId }),
    });
    const b = await http(`${BASE}/api/payments/init`, {
      method: 'POST',
      cookies: customerCookie(),
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ orderId: o.publicId }),
    });
    const sessA = a.body?.data?.providerSessionId;
    const sessB = b.body?.data?.providerSessionId;
    record(
      'S2 init replay returns same session',
      a.status === b.status && sessA === sessB && !!sessA,
      `a=${a.status}/${sessA} b=${b.status}/${sessB}`,
    );
  } catch (err) {
    record('S2 init replay returns same session', false, (err as Error).message);
  }

  // ────── S3: capture + reserveStock fails -> auto-refund ──────────────────
  try {
    const o = await seedOrder(k, { productId: MISSING_PRODUCT_ID, quantity: 1 });
    const init = await http(`${BASE}/api/payments/init`, {
      method: 'POST',
      cookies: customerCookie(),
      headers: { 'Idempotency-Key': `${o.publicId}-init` },
      body: JSON.stringify({ orderId: o.publicId }),
    });
    if (![200, 201].includes(init.status)) {
      record('S3 capture out-of-stock auto-refund', false, `init -> ${init.status}`);
    } else {
      const wh = await captureSimulated(
        o.publicId,
        init.body.data.providerSessionId,
        2500 + 1500,
      );
      if (wh.status !== 200) {
        record('S3 capture out-of-stock auto-refund', false, `webhook -> ${wh.status}`);
      } else {
        // Wait for the auto-cancel + refund-row to land.
        const order = await waitFor(async () => {
          const row = await k('orders')
            .select('status')
            .where('id', o.id)
            .first();
          return row?.status === 'cancelled' ? row : null;
        });
        const refund = await waitFor(async () => {
          const row = await k('transactions')
            .select('id', 'status', 'transaction_type', 'refunded_payment_id')
            .where({ order_id: o.id, transaction_type: 'refund' })
            .first();
          return row ?? null;
        });
        const charge = await k('transactions')
          .select('id', 'status', 'is_refunded')
          .where({ order_id: o.id, transaction_type: 'charge' })
          .first();
        const ok =
          order?.status === 'cancelled' &&
          !!refund &&
          charge?.status === 'succeeded';
        record(
          'S3 capture out-of-stock auto-refund',
          ok,
          `order=${order?.status} charge=${charge?.status} refund=${refund?.status}`,
        );
      }
    }
  } catch (err) {
    record('S3 capture out-of-stock auto-refund', false, (err as Error).message);
  }

  // ────── S4: webhook pay/FAILED ───────────────────────────────────────────
  try {
    const o = await seedOrder(k, { productId: REAL_PRODUCT_ID, quantity: 1 });
    const init = await http(`${BASE}/api/payments/init`, {
      method: 'POST',
      cookies: customerCookie(),
      headers: { 'Idempotency-Key': `${o.publicId}-init` },
      body: JSON.stringify({ orderId: o.publicId }),
    });
    const providerSession = init.body?.data?.providerSessionId;
    const data = {
      merchantOrderId: o.publicId,
      transactionId: `tx_fail_${providerSession}`,
      status: 'FAILED',
      amount: 40,
      currency: 'EGP',
      signatureKeys: [
        'amount',
        'currency',
        'merchantOrderId',
        'status',
        'transactionId',
      ],
    };
    const sig = signKashier(data);
    const wh = await http(`${BASE}/api/payments/webhook/kashier`, {
      method: 'POST',
      headers: { 'x-kashier-signature': sig },
      body: JSON.stringify({ event: 'pay', data }),
    });
    const order = await k('orders').select('status').where('id', o.id).first();
    const session = await k('payment_sessions')
      .select('status')
      .where({ order_id: o.id })
      .orderBy('id', 'desc')
      .first();
    const ok =
      wh.status === 200 &&
      order?.status === 'pending_payment' &&
      session?.status === 'failed';
    record(
      'S4 webhook FAILED keeps order pending_payment',
      ok,
      `wh=${wh.status} order=${order?.status} session=${session?.status}`,
    );
  } catch (err) {
    record('S4 webhook FAILED keeps order pending_payment', false, (err as Error).message);
  }

  // ────── S5: duplicate webhook delivery ──────────────────────────────────
  try {
    const o = await seedOrder(k, { productId: REAL_PRODUCT_ID, quantity: 1 });
    const init = await http(`${BASE}/api/payments/init`, {
      method: 'POST',
      cookies: customerCookie(),
      headers: { 'Idempotency-Key': `${o.publicId}-init` },
      body: JSON.stringify({ orderId: o.publicId }),
    });
    const providerSession = init.body?.data?.providerSessionId;
    const txId = `tx_dup_${providerSession}`;
    const data = {
      merchantOrderId: o.publicId,
      kashierOrderId: `ks_${providerSession}`,
      transactionId: txId,
      status: 'SUCCESS',
      method: 'card',
      amount: 40,
      currency: 'EGP',
      signatureKeys: [
        'amount',
        'currency',
        'merchantOrderId',
        'status',
        'transactionId',
      ],
    };
    const sig = signKashier(data);
    const first = await http(`${BASE}/api/payments/webhook/kashier`, {
      method: 'POST',
      headers: { 'x-kashier-signature': sig },
      body: JSON.stringify({ event: 'pay', data }),
    });
    const second = await http(`${BASE}/api/payments/webhook/kashier`, {
      method: 'POST',
      headers: { 'x-kashier-signature': sig },
      body: JSON.stringify({ event: 'pay', data }),
    });
    // wait for settlement on the FIRST one (so the dup test result isn't
    // racing against the first's stock-reserve thread).
    await waitFor(async () => {
      const row = await k('orders').select('status').where('id', o.id).first();
      return row?.status === 'placed' ? row : null;
    });
    const charges = await k('transactions')
      .where({ order_id: o.id, transaction_type: 'charge' })
      .count<{ count: string }[]>('id as count');
    const ok =
      first.status === 200 &&
      second.status === 200 &&
      Number(charges[0].count) === 1;
    record(
      'S5 duplicate webhook collapses',
      ok,
      `first=${first.status} second=${second.status} charges=${charges[0].count}`,
    );
  } catch (err) {
    record('S5 duplicate webhook collapses', false, (err as Error).message);
  }

  // ────── S6: bad signature ───────────────────────────────────────────────
  try {
    const r = await http(`${BASE}/api/payments/webhook/kashier`, {
      method: 'POST',
      headers: { 'x-kashier-signature': 'BAD'.repeat(20) },
      body: JSON.stringify({
        event: 'pay',
        data: {
          merchantOrderId: 'x',
          transactionId: 'x',
          status: 'SUCCESS',
          amount: 1,
          currency: 'EGP',
          signatureKeys: [
            'amount',
            'currency',
            'merchantOrderId',
            'status',
            'transactionId',
          ],
        },
      }),
    });
    record('S6 bad-signature webhook -> 401', r.status === 401, `status=${r.status}`);
  } catch (err) {
    record('S6 bad-signature webhook -> 401', false, (err as Error).message);
  }

  // ────── S7: webhook with unknown merchantOrderId (valid sig) ────────────
  try {
    const data = {
      merchantOrderId: uuidv4(),
      transactionId: `tx_unknown_${Date.now()}`,
      status: 'SUCCESS',
      amount: 1,
      currency: 'EGP',
      signatureKeys: [
        'amount',
        'currency',
        'merchantOrderId',
        'status',
        'transactionId',
      ],
    };
    const r = await http(`${BASE}/api/payments/webhook/kashier`, {
      method: 'POST',
      headers: { 'x-kashier-signature': signKashier(data) },
      body: JSON.stringify({ event: 'pay', data }),
    });
    record('S7 unknown merchantOrderId silently acked', r.status === 200, `status=${r.status}`);
  } catch (err) {
    record('S7 unknown merchantOrderId silently acked', false, (err as Error).message);
  }

  // ────── S8: init for non-existent order ─────────────────────────────────
  try {
    const r = await http(`${BASE}/api/payments/init`, {
      method: 'POST',
      cookies: customerCookie(),
      headers: { 'Idempotency-Key': `nope-${uuidv4()}` },
      body: JSON.stringify({ orderId: uuidv4() }),
    });
    record('S8 init unknown order -> 404', r.status === 404, `status=${r.status}`);
  } catch (err) {
    record('S8 init unknown order -> 404', false, (err as Error).message);
  }

  // ────── S9: init for already-placed order ───────────────────────────────
  try {
    const o = await seedOrder(k, { status: 'placed', productId: REAL_PRODUCT_ID });
    const r = await http(`${BASE}/api/payments/init`, {
      method: 'POST',
      cookies: customerCookie(),
      headers: { 'Idempotency-Key': `placed-${o.publicId}` },
      body: JSON.stringify({ orderId: o.publicId }),
    });
    record('S9 init already-placed -> 409', r.status === 409, `status=${r.status}`);
  } catch (err) {
    record('S9 init already-placed -> 409', false, (err as Error).message);
  }

  // ────── S10: sweeper - abandoned order beyond grace ─────────────────────
  try {
    const ageMin = GRACE_MIN + 30;
    const o = await seedOrder(k, {
      productId: REAL_PRODUCT_ID,
      ageMinutes: ageMin,
    });
    // Seed an expired session row so the candidate would be visible regardless
    // of whether /init was ever called.
    await k('payment_sessions').insert({
      region: REGION,
      order_id: o.id,
      order_created_at: o.createdAt,
      provider_id: 1,
      provider_session_id: `sess_stale_${o.publicId}`,
      amount: 4000,
      currency: 'EGP',
      status: 'initialized',
      redirect_url: `https://payments.kashier.io/session/sess_stale_${o.publicId}`,
      raw_init_payload: JSON.stringify({ synthetic: true }),
      expires_at: new Date(Date.now() - ageMin * 60_000),
      created_at: new Date(Date.now() - ageMin * 60_000),
      updated_at: new Date(Date.now() - ageMin * 60_000),
    });
    const r = await http(`${BASE}/api/payments/internal/sweeper/run`, {
      method: 'POST',
      headers: { 'x-api-key': process.env.CORE_INTERNAL_API_KEY ?? 'changeme' },
    });
    // Fallback: if internal route is missing, wait up to ~70s for cron tick.
    const order = await waitFor(
      async () => {
        const row = await k('orders').select('status').where('id', o.id).first();
        return row?.status === 'cancelled' ? row : null;
      },
      r.status === 404 ? 70_000 : 5_000,
    );
    const session = await k('payment_sessions')
      .select('status')
      .where({ order_id: o.id })
      .orderBy('id', 'desc')
      .first();
    const ok =
      order?.status === 'cancelled' && session?.status === 'expired';
    record(
      'S10 sweeper cancels abandoned order',
      ok,
      `order=${order?.status} session=${session?.status} runEndpoint=${r.status}`,
    );
  } catch (err) {
    record('S10 sweeper cancels abandoned order', false, (err as Error).message);
  }

  // ────── S11: sweeper leaves fresh sessions alone ────────────────────────
  try {
    const o = await seedOrder(k, { productId: REAL_PRODUCT_ID, ageMinutes: 2 });
    await k('payment_sessions').insert({
      region: REGION,
      order_id: o.id,
      order_created_at: o.createdAt,
      provider_id: 1,
      provider_session_id: `sess_fresh_${o.publicId}`,
      amount: 4000,
      currency: 'EGP',
      status: 'initialized',
      redirect_url: `https://payments.kashier.io/session/sess_fresh_${o.publicId}`,
      raw_init_payload: JSON.stringify({ synthetic: true }),
      expires_at: new Date(Date.now() + 13 * 60_000),
      created_at: new Date(Date.now() - 2 * 60_000),
      updated_at: new Date(Date.now() - 2 * 60_000),
    });
    // best-effort trigger; ignore status
    await http(`${BASE}/api/payments/internal/sweeper/run`, {
      method: 'POST',
      headers: { 'x-api-key': process.env.CORE_INTERNAL_API_KEY ?? 'changeme' },
    });
    await new Promise((r) => setTimeout(r, 1500));
    const order = await k('orders').select('status').where('id', o.id).first();
    const session = await k('payment_sessions')
      .select('status')
      .where({ order_id: o.id })
      .orderBy('id', 'desc')
      .first();
    const ok =
      order?.status === 'pending_payment' && session?.status === 'initialized';
    record(
      'S11 sweeper skips fresh session',
      ok,
      `order=${order?.status} session=${session?.status}`,
    );
  } catch (err) {
    record('S11 sweeper skips fresh session', false, (err as Error).message);
  }

  // ────── S12: sweeper leaves already-placed orders alone ─────────────────
  try {
    const o = await seedOrder(k, {
      status: 'placed',
      productId: REAL_PRODUCT_ID,
      ageMinutes: 60,
    });
    await http(`${BASE}/api/payments/internal/sweeper/run`, {
      method: 'POST',
      headers: { 'x-api-key': process.env.CORE_INTERNAL_API_KEY ?? 'changeme' },
    });
    await new Promise((r) => setTimeout(r, 1500));
    const order = await k('orders').select('status').where('id', o.id).first();
    record(
      'S12 sweeper skips already-placed order',
      order?.status === 'placed',
      `order=${order?.status}`,
    );
  } catch (err) {
    record('S12 sweeper skips already-placed order', false, (err as Error).message);
  }

  // ────── S13: admin refund flow ──────────────────────────────────────────
  try {
    const o = await seedOrder(k, { productId: REAL_PRODUCT_ID, quantity: 1 });
    const init = await http(`${BASE}/api/payments/init`, {
      method: 'POST',
      cookies: customerCookie(),
      headers: { 'Idempotency-Key': `${o.publicId}-init` },
      body: JSON.stringify({ orderId: o.publicId }),
    });
    const sess = init.body?.data?.providerSessionId;
    await captureSimulated(o.publicId, sess, 4000);
    await waitFor(async () => {
      const row = await k('orders').select('status').where('id', o.id).first();
      return row?.status === 'placed' ? row : null;
    });
    const charge = await k('transactions')
      .select('id', 'provider_reference_id', 'amount', 'currency')
      .where({ order_id: o.id, transaction_type: 'charge' })
      .first();
    if (!charge) {
      record('S13 admin refund flow', false, 'no charge row');
    } else {
      const refundRes = await http(`${BASE}/api/payments/${charge.id}/refund`, {
        method: 'POST',
        cookies: adminCookie(),
        headers: { 'Idempotency-Key': `${o.publicId}-refund` },
        body: JSON.stringify({ amount: 1000, reason: 'partial test refund' }),
      });
      // Kashier will reject the fake provider txn id → refund row ends up
      // failed. That's fine; the upstream call was real, and the refund-success
      // webhook path is exercised next.
      const refundRow = await waitFor(async () => {
        const row = await k('transactions')
          .where({ refunded_payment_id: charge.id, transaction_type: 'refund' })
          .orderBy('created_at', 'desc')
          .first();
        return row ?? null;
      });
      if (!refundRow) {
        record(
          'S13 admin refund flow',
          false,
          `refundRes=${refundRes.status} no row inserted`,
        );
      } else {
        // Force a provider_reference_id so we can fake a refund-success
        // webhook against the same row.
        const providerRef =
          refundRow.provider_reference_id ?? `simref_${refundRow.id}`;
        if (!refundRow.provider_reference_id) {
          await k('transactions')
            .where('id', refundRow.id)
            .update({ provider_reference_id: providerRef });
        }
        const data = {
          merchantOrderId: o.publicId,
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
        const sig = signKashier(data);
        const wh = await http(`${BASE}/api/payments/webhook/kashier`, {
          method: 'POST',
          headers: { 'x-kashier-signature': sig },
          body: JSON.stringify({ event: 'refund', data }),
        });
        const finalRefund = await k('transactions')
          .select('status')
          .where('id', refundRow.id)
          .first();
        const finalCharge = await k('transactions')
          .select('is_refunded')
          .where('id', charge.id)
          .first();
        const ok =
          refundRes.status === 201 ||
          refundRes.status === 200 ||
          refundRes.status === 503; // 503 only when upstream rejects
        const refundOk =
          finalRefund?.status === 'succeeded' && wh.status === 200;
        record(
          'S13 admin refund flow + refund webhook',
          ok && refundOk,
          `refundReq=${refundRes.status} webhook=${wh.status} refund=${finalRefund?.status} chargeRefunded=${finalCharge?.is_refunded}`,
        );
      }
    }
  } catch (err) {
    record('S13 admin refund flow + refund webhook', false, (err as Error).message);
  }

  // ────── S14: GET /payments/:id authz matrix ─────────────────────────────
  try {
    // Reuse a known charge from the DB (the latest captured one).
    const charge = await k('transactions')
      .select('id', 'order_id')
      .where('transaction_type', 'charge')
      .andWhere('status', 'succeeded')
      .orderBy('id', 'desc')
      .first();
    if (!charge) {
      record('S14 GET /payments/:id authz matrix', false, 'no charge row to read');
    } else {
      const admin = await http(`${BASE}/api/payments/${charge.id}`, {
        method: 'GET',
        cookies: adminCookie(),
      });
      const customer = await http(`${BASE}/api/payments/${charge.id}`, {
        method: 'GET',
        cookies: customerCookie(),
      });
      const owner = await http(`${BASE}/api/payments/${charge.id}`, {
        method: 'GET',
        cookies: restaurantUserCookie(RESTAURANT_ID),
      });
      const stranger = await http(`${BASE}/api/payments/${charge.id}`, {
        method: 'GET',
        cookies: restaurantUserCookie(9999),
      });
      const ok =
        admin.status === 200 &&
        customer.status === 403 &&
        owner.status === 200 &&
        stranger.status === 403;
      record(
        'S14 GET /payments/:id authz matrix',
        ok,
        `admin=${admin.status} customer=${customer.status} owner=${owner.status} stranger=${stranger.status}`,
      );
    }
  } catch (err) {
    record('S14 GET /payments/:id authz matrix', false, (err as Error).message);
  }

  await k.destroy();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n──── SUMMARY ────`);
  console.log(`passed: ${passed}/${results.length}`);
  if (failed > 0) {
    console.log(`failed:`);
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  - ${r.name} :: ${r.details}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
