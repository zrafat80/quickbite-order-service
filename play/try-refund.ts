/**
 * Hand-runnable refund probe — call any time to retry the refund against
 * Kashier sandbox. Resets the prior failed refund row first, so each run
 * is a fresh attempt (not a replay of the stale row).
 *
 *   npx ts-node play/try-refund.ts
 *
 * Targets charge id=27 (the real Kashier-captured charge from the live test).
 */
import knex from 'knex';
import { config as loadEnv } from 'dotenv';
import * as jwt from 'jsonwebtoken';
loadEnv();

const CHARGE_ID = 27;
const REFUND_AMOUNT_MINOR = 4000;
const ORDER_PUBLIC_ID = 'de5bdbac-a0b4-46b6-8c95-2a05b59e2e14';

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

  // 1. clear any prior failed refund for this charge+amount so we hit Kashier fresh
  const cleared = await k('transactions')
    .where({
      refunded_payment_id: CHARGE_ID,
      transaction_type: 'refund',
      status: 'failed',
      amount: REFUND_AMOUNT_MINOR,
    })
    .del();
  if (cleared) console.log(`cleared ${cleared} prior failed refund row(s)`);

  // 2. call the admin refund endpoint
  const adminToken = jwt.sign(
    { userId: 1, role: 'system_admin' },
    process.env.ACCESS_SECRET!,
    { expiresIn: '1h' },
  );
  console.log(`calling POST /api/payments/${CHARGE_ID}/refund …`);
  const res = await fetch(`http://localhost:4000/api/payments/${CHARGE_ID}/refund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Region': 'eg',
      'Cookie': `access_token=${adminToken}`,
      'Idempotency-Key': `refund-try-${ORDER_PUBLIC_ID}-${Date.now()}`,
    },
    body: JSON.stringify({ amount: REFUND_AMOUNT_MINOR, reason: 'manual try' }),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text);

  // 3. show the refund row + charge state
  const refund = await k('transactions')
    .where({ refunded_payment_id: CHARGE_ID, transaction_type: 'refund' })
    .orderBy('id', 'desc')
    .first();
  const charge = await k('transactions').where('id', CHARGE_ID).first();
  console.log('');
  console.log('DB state:');
  console.log(`  refund: id=${refund?.id} status=${refund?.status} amount=${refund?.amount} provider_ref=${refund?.provider_reference_id}`);
  console.log(`  charge: status=${charge?.status} is_refunded=${charge?.is_refunded} provider_order_id=${charge?.provider_order_id}`);

  if (res.status >= 200 && res.status < 300) {
    console.log('');
    console.log('🟢 Kashier accepted the refund. A refund webhook should arrive shortly via ngrok.');
    console.log('   Watch with:  npx ts-node play/inspect-refund.ts  (or wait ~30s and rerun).');
  } else if (res.status === 503) {
    console.log('');
    console.log('🔴 Kashier sandbox still 500-ing (their bug). Try again later.');
  }

  await k.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
