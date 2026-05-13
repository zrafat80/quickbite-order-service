/**
 * Backfill: for existing charge rows, extract data.kashierOrderId from the
 * matching capture webhook payload and stamp it on transactions.provider_order_id.
 * Idempotent — only updates rows where provider_order_id IS NULL.
 */
import knex from 'knex';
import { config as loadEnv } from 'dotenv';
loadEnv();

(async () => {
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

  // Find candidates: charges with no provider_order_id but with provider_reference_id.
  const charges = await k('transactions')
    .select('id', 'provider_reference_id')
    .where({ transaction_type: 'charge', status: 'succeeded' })
    .whereNull('provider_order_id')
    .whereNotNull('provider_reference_id');
  console.log(`backfill candidates: ${charges.length}`);

  for (const c of charges) {
    // Find the pay webhook with this transactionId.
    const ev = await k('payment_webhook_events')
      .select('payload')
      .where('event_type', 'pay')
      .andWhereRaw("payload->'data'->>'transactionId' = ?", [c.provider_reference_id])
      .first();
    const kid = ev?.payload?.data?.kashierOrderId;
    if (!kid) {
      console.log(`  charge id=${c.id} ref=${c.provider_reference_id} — no kashierOrderId found, skipping`);
      continue;
    }
    await k('transactions').where('id', c.id).update({ provider_order_id: kid });
    console.log(`  charge id=${c.id} ref=${c.provider_reference_id} → kashierOrderId=${kid}`);
  }
  await k.destroy();
})();
