/**
 * Audit: list all transactions with their provider_reference_id and a hint at
 * which are real Kashier vs which are synthetic test rows.
 *
 * Kashier real txn id format: `TX-` followed by digits (e.g. TX-4569455616).
 * Anything else (tx_*, tx_test_*, tx_dup_*) is from a synthetic test webhook.
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

  const rows = await k('transactions')
    .select('id', 'transaction_type', 'status', 'provider_reference_id', 'provider_order_id', 'amount', 'order_id', 'refunded_payment_id')
    .orderBy('id', 'asc');
  for (const r of rows) {
    const ref = r.provider_reference_id;
    let kind: string;
    if (!ref) kind = '—none—';
    else if (/^TX-\d+$/.test(ref)) kind = 'REAL Kashier';
    else if (/^simref_/.test(ref)) kind = 'synthetic refund probe';
    else kind = 'synthetic (e2e/dev test)';
    console.log(
      `id=${r.id} type=${r.transaction_type} status=${r.status} order=${r.order_id} refundedPayment=${r.refunded_payment_id ?? '-'} amount=${r.amount} ref=${ref ?? 'NULL'}   [${kind}]`,
    );
  }

  // Look for duplicate provider_reference_ids (would mean a real and a fake collide).
  const dups = await k('transactions')
    .select('provider_reference_id')
    .count<{ count: string }[]>('id as count')
    .whereNotNull('provider_reference_id')
    .groupBy('provider_reference_id')
    .having(k.raw('count(id) > 1'));
  if (dups.length === 0) {
    console.log('\nno duplicate provider_reference_id values — safe.');
  } else {
    console.log('\nDUPLICATES FOUND:');
    console.log(dups);
  }
  await k.destroy();
})();
