/**
 * Phase 2 edge cases. Run after the dev server is up.
 *   - bad signature webhook -> 401
 *   - unknown merchantOrderId webhook -> 200 (silently dropped)
 *   - init for non-existent order -> 404
 *   - init for already-placed order -> 409
 */

import { config as loadEnv } from 'dotenv';
import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';
import knex from 'knex';

loadEnv();

const BASE = 'http://localhost:4000';
const REGION = 'eg';

function customerToken(userId: number) {
  return jwt.sign({ userId, role: 'customer' }, process.env.ACCESS_SECRET!, {
    expiresIn: '1h',
  });
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

  // ─── 1. webhook with bad signature ───────────────────────────────────────
  const badData = {
    merchantOrderId: 'does-not-matter',
    transactionId: 't1',
    status: 'SUCCESS',
    amount: 10,
    currency: 'EGP',
    signatureKeys: ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'],
  };
  const r1 = await fetch(`${BASE}/api/payments/webhook/kashier`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Region': REGION,
      'x-kashier-signature': 'BAD'.repeat(20),
    },
    body: JSON.stringify({ event: 'pay', data: badData }),
  });
  console.log(`bad sig -> ${r1.status} ${(await r1.text()).slice(0, 160)}`);

  // ─── 2. webhook with unknown merchantOrderId (good sig) ──────────────────
  const goodSig = createHmac('sha256', process.env.KASHIER_API_KEY!)
    .update(
      ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId']
        .map(
          (k) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String((badData as any)[k]))}`,
        )
        .join('&'),
    )
    .digest('hex');
  const r2 = await fetch(`${BASE}/api/payments/webhook/kashier`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Region': REGION,
      'x-kashier-signature': goodSig,
    },
    body: JSON.stringify({ event: 'pay', data: badData }),
  });
  console.log(`unknown order -> ${r2.status} ${(await r2.text()).slice(0, 160)}`);

  // ─── 3. init for non-existent order ──────────────────────────────────────
  const tok = customerToken(5);
  const r3 = await fetch(`${BASE}/api/payments/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Region': REGION,
      Cookie: `access_token=${tok}`,
      'Idempotency-Key': `init-nope-${uuidv4()}`,
    },
    body: JSON.stringify({ orderId: uuidv4() }),
  });
  console.log(`init unknown -> ${r3.status} ${(await r3.text()).slice(0, 160)}`);

  // ─── 4. init for already-placed order ────────────────────────────────────
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
      delivery_lat: 30.0,
      delivery_lng: 31.0,
      delivery_address_text_snapshot: 'placed-order',
      status: 'placed', // already past pending_payment
      subtotal: 1000,
      delivery_fee: 0,
      service_fee: 0,
      total: 1000,
      currency: 'EGP',
      payment_method: 'online',
    })
    .returning(['id']);
  const r4 = await fetch(`${BASE}/api/payments/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Region': REGION,
      Cookie: `access_token=${tok}`,
      'Idempotency-Key': `init-placed-${uuidv4()}`,
    },
    body: JSON.stringify({ orderId: publicId }),
  });
  console.log(
    `init placed (id=${orderRow.id}) -> ${r4.status} ${(await r4.text()).slice(0, 160)}`,
  );

  await k.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
