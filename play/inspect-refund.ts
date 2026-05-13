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

  const charge = await k('transactions').where('id', 27).first();
  console.log('charge id=27:', {
    status: charge?.status,
    provider_reference_id: charge?.provider_reference_id,
    is_refunded: charge?.is_refunded,
    amount: charge?.amount,
  });
  const refunds = await k('transactions')
    .where({ refunded_payment_id: 27, transaction_type: 'refund' });
  console.log('refund rows:', refunds);

  await k.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
