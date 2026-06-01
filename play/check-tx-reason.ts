/**
 * Smoke check: pre-existing transactions (inserted before the migration)
 * read cleanly through the updated repository + entity with the new `reason`
 * column. Also asserts the CHECK constraint accepts the new leg types.
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

  const sample = await k('transactions')
    .select('id', 'transaction_type', 'reason')
    .orderBy('id', 'desc')
    .limit(5);
  console.log('latest 5 transactions:', sample);

  const has = sample.every((r) => 'reason' in r);
  console.log('reason column present on every row:', has);

  // Confirm the new check constraint accepts a new type by EXPLAINing an insert
  // that we then roll back.
  await k.transaction(async (trx) => {
    await trx.raw(`
      INSERT INTO transactions (
        region, transaction_type, method, status, amount, currency, reason
      ) VALUES ('eg', 'service_fee', 'system', 'succeeded', 1, 'EGP', 'smoke-check');
    `);
    await trx.rollback();
  }).catch((e) => {
    if ((e as Error).message.includes('Transaction rejected with non-error')) return;
    throw e;
  });

  console.log('OK: CHECK accepts new leg type service_fee');
  await k.destroy();
}

main().catch((e) => {
  console.error('FAIL:', (e as Error).message);
  process.exit(1);
});
