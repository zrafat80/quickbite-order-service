/**
 * Live refund end-to-end test.
 *
 * Uses the charge written by the previous live-pay run (id=27, real
 * provider_reference_id from Kashier sandbox). Steps:
 *   1. POST /api/payments/27/refund with a system_admin cookie + full amount.
 *   2. Print the immediate response — Kashier's real refund API is called
 *      synchronously, so the refund row's status reflects what Kashier said.
 *   3. Poll for the refund webhook delivered back through ngrok; expect:
 *        - payment_webhook_events row with event_type='refund' processed_at!=null
 *        - the refund tx row status='succeeded'
 *        - the original charge tx is_refunded=true
 */
import knex from 'knex';
import { config as loadEnv } from 'dotenv';
import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
loadEnv();

const BASE = 'http://localhost:4000';
const REGION = 'eg';

const CHARGE_ID = 27;
const ORDER_ID = 52;
const ORDER_PUBLIC_ID = 'de5bdbac-a0b4-46b6-8c95-2a05b59e2e14';
const REFUND_AMOUNT_MINOR = 4000;

function adminCookie(): string {
  const t = jwt.sign({ userId: 1, role: 'system_admin' }, process.env.ACCESS_SECRET!, {
    expiresIn: '1h',
  });
  return `access_token=${t}`;
}

async function fetchJson(url: string, init: RequestInit & { cookies?: string } = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Region': REGION,
    ...((init.headers as Record<string, string>) || {}),
  };
  if (init.cookies) headers['Cookie'] = init.cookies;
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
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

  const chargeBefore = await k('transactions').where('id', CHARGE_ID).first();
  if (!chargeBefore) {
    console.error(`charge id=${CHARGE_ID} not found`);
    process.exit(1);
  }
  console.log(
    `charge BEFORE refund: id=${chargeBefore.id} status=${chargeBefore.status} amount=${chargeBefore.amount} provider_ref=${chargeBefore.provider_reference_id} is_refunded=${chargeBefore.is_refunded}`,
  );

  // ── 1. call admin refund ────────────────────────────────────────────────
  const idemKey = `refund-live-${ORDER_PUBLIC_ID}`;
  const res = await fetchJson(`${BASE}/api/payments/${CHARGE_ID}/refund`, {
    method: 'POST',
    cookies: adminCookie(),
    headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify({ amount: REFUND_AMOUNT_MINOR, reason: 'live e2e refund test' }),
  });
  console.log(`admin refund -> ${res.status}`);
  console.log(`response body: ${JSON.stringify(res.body, null, 2)}`);

  if (![200, 201].includes(res.status)) {
    console.error('admin refund request failed; aborting');
    await k.destroy();
    process.exit(1);
  }

  const refundRow = await k('transactions')
    .where({ refunded_payment_id: CHARGE_ID, transaction_type: 'refund' })
    .orderBy('id', 'desc')
    .first();
  console.log(
    `refund row AFTER api call: id=${refundRow?.id} status=${refundRow?.status} amount=${refundRow?.amount} provider_ref=${refundRow?.provider_reference_id}`,
  );

  // ── 2. poll for refund webhook ──────────────────────────────────────────
  console.log('');
  console.log('waiting for Kashier refund webhook (up to 3 min)…');
  const deadline = Date.now() + 3 * 60 * 1000;
  let pollNo = 0;
  let webhookSeen = false;
  while (Date.now() < deadline) {
    pollNo++;
    await new Promise((r) => setTimeout(r, 2000));
    const ev = await k('payment_webhook_events')
      .whereRaw("payload::text ILIKE ?", [`%${ORDER_PUBLIC_ID}%`])
      .andWhere('event_type', 'refund')
      .orderBy('received_at', 'desc');
    if (ev.length > 0 && !webhookSeen) {
      webhookSeen = true;
      console.log(`[poll ${pollNo}] received ${ev.length} refund webhook event(s)`);
      for (const e of ev) {
        console.log(
          `   id=${e.id} processed_at=${e.processed_at ?? 'NULL'} err=${e.process_error ?? '-'}`,
        );
      }
    }
    const refund = await k('transactions').where('id', refundRow?.id).first();
    const charge = await k('transactions').where('id', CHARGE_ID).first();
    if (webhookSeen && refund?.status === 'succeeded' && charge?.is_refunded) {
      console.log('');
      console.log('FINAL:');
      console.log(`  refund id=${refund.id} status=${refund.status} amount=${refund.amount} provider_ref=${refund.provider_reference_id}`);
      console.log(`  charge id=${charge.id} is_refunded=${charge.is_refunded} status=${charge.status}`);
      const order = await k('orders').select('status').where('id', ORDER_ID).first();
      console.log(`  order  status=${order?.status}`);
      await k.destroy();
      return;
    }
  }

  console.log('TIMEOUT — refund webhook never landed. Current state:');
  const refundFinal = await k('transactions').where('id', refundRow?.id).first();
  const chargeFinal = await k('transactions').where('id', CHARGE_ID).first();
  console.log(`  refund: ${JSON.stringify(refundFinal, null, 2)}`);
  console.log(`  charge: ${JSON.stringify(chargeFinal, null, 2)}`);
  await k.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
