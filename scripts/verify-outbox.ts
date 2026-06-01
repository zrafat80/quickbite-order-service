// Throwaway verification script: confirms events_outbox exists, inserts a
// synthetic order.placed row, waits for the drainer to dispatch it, then
// reports whether dispatched_at got set. Mirrors what the real placeOrder
// flow writes into the outbox.
import knex from 'knex';
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'crypto';

loadDotenv();

async function main() {
  const db = knex({
    client: 'pg',
    connection: {
      host: process.env.DB_eg_HOST,
      port: Number(process.env.DB_eg_PORT),
      user: process.env.DB_eg_USERNAME,
      password: process.env.DB_eg_PASSWORD,
      database: process.env.DB_eg_NAME,
    },
  });

  const before = await db.raw(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'events_outbox'`,
  );
  console.log('table_exists =', before.rows[0].n === 1);

  const eventId = randomUUID();
  const orderId = randomUUID();
  await db('events_outbox').insert({
    aggregate_type: 'order',
    aggregate_id: orderId,
    event_type: 'order.placed',
    event_id: eventId,
    payload: JSON.stringify({
      orderId,
      region: 'eg',
      countryCode: 'EG',
      restaurantId: 42,
      branchId: 1,
      customerId: 1,
      status: 'placed',
      paymentMethod: 'cod',
      subtotal: 777,
      deliveryFee: 0,
      serviceFee: 0,
      total: 777,
      currency: 'EGP',
      items: [{ productId: 10, quantity: 1, unitPriceSnapshot: 777, lineTotal: 777 }],
      placedAt: new Date().toISOString(),
    }),
  });
  console.log('inserted eventId =', eventId);

  // Drainer ticks every 2s, so 6s is generous.
  await new Promise((r) => setTimeout(r, 6000));

  const row = await db('events_outbox')
    .where({ event_id: eventId })
    .first('id', 'dispatched_at', 'attempts', 'last_error');
  console.log('row =', row);

  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
