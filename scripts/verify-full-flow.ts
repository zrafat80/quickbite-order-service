// Throwaway: drop synthetic outbox rows of each new event type so the
// real order-service drainer publishes them to RabbitMQ, exercising the
// production publisher-side path.
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

  const orderId = randomUUID();
  const eventId = randomUUID();
  const restaurantId = 99;
  const branchId = 99;
  const productId = 99;
  const total = 5500;
  const currency = 'EGP';
  const placedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  const deliveredAt = new Date().toISOString();
  const rejectedAt = new Date().toISOString();

  // 1. order.placed (COD pattern)
  await db('events_outbox').insert({
    aggregate_type: 'order',
    aggregate_id: orderId,
    event_type: 'order.placed',
    event_id: randomUUID(),
    payload: JSON.stringify({
      orderId, region: 'eg', countryCode: 'EG',
      restaurantId, branchId, customerId: 1,
      status: 'placed', paymentMethod: 'cod',
      subtotal: total, deliveryFee: 0, serviceFee: 0, total, currency,
      items: [{ productId, quantity: 1, unitPriceSnapshot: total, lineTotal: total }],
      placedAt,
    }),
  });

  // 2. order.delivered for that order
  await db('events_outbox').insert({
    aggregate_type: 'order',
    aggregate_id: orderId,
    event_type: 'order.delivered',
    event_id: randomUUID(),
    payload: JSON.stringify({
      orderId, region: 'eg', restaurantId, branchId, currency,
      placedAt, deliveredAt,
    }),
  });

  // 3. order.rejected (separate order)
  const orderId2 = randomUUID();
  await db('events_outbox').insert({
    aggregate_type: 'order',
    aggregate_id: orderId2,
    event_type: 'order.placed',
    event_id: randomUUID(),
    payload: JSON.stringify({
      orderId: orderId2, region: 'eg', countryCode: 'EG',
      restaurantId, branchId, customerId: 1,
      status: 'placed', paymentMethod: 'cod',
      subtotal: 1000, deliveryFee: 0, serviceFee: 0, total: 1000, currency,
      items: [{ productId, quantity: 1, unitPriceSnapshot: 1000, lineTotal: 1000 }],
      placedAt,
    }),
  });
  await db('events_outbox').insert({
    aggregate_type: 'order',
    aggregate_id: orderId2,
    event_type: 'order.rejected',
    event_id: randomUUID(),
    payload: JSON.stringify({
      orderId: orderId2, region: 'eg', restaurantId, branchId, currency, rejectedAt,
    }),
  });

  // 4. payment.completed (online order; no order.placed sibling here so
  //    the recognition happens entirely at capture time)
  const orderId3 = randomUUID();
  await db('events_outbox').insert({
    aggregate_type: 'order',
    aggregate_id: orderId3,
    event_type: 'payment.completed',
    event_id: randomUUID(),
    payload: JSON.stringify({
      orderId: orderId3, region: 'eg', restaurantId, branchId,
      total: 7000, currency,
      items: [{ productId, quantity: 1, unitPriceSnapshot: 7000, lineTotal: 7000 }],
      completedAt: new Date().toISOString(),
    }),
  });

  console.log('inserted 5 outbox rows for restaurant 99 / branch 99 / product 99');
  console.log('  order.placed (A)   → 5500 (will be delivered)');
  console.log('  order.delivered (A) → 45 min latency');
  console.log('  order.placed (B)   → 1000 (will be rejected)');
  console.log('  order.rejected (B)');
  console.log('  payment.completed (C, online) → 7000');
  console.log('expected restaurant 99: orders_count=3, revenue=13500, rejected=1, delivery_ms_count=1');
  console.log('drainer ticks ~2s; waiting 6s then exiting');
  await new Promise(r => setTimeout(r, 6000));
  await db.destroy();
}
main().catch(e => { console.error(e); process.exit(1); });
