/**
 * Iterative test for PaymentSessionSweeperWorker.
 *
 * Scenarios (all in region 'eg', online payment):
 *   A. order created 30min ago, session expired 15min ago  → expected: session→expired, order→cancelled
 *   B. order created 30min ago, NO session yet              → expected: order→cancelled (grace window passed)
 *   C. order created 2min ago, session still active         → expected: untouched
 *   D. order created 30min ago, session is already 'failed' → expected: order→cancelled (no live session)
 *   E. order already 'placed' (capture happened)            → expected: untouched
 *
 * Drives the sweeper by reaching into the running app's PaymentSessionSweeperWorker
 * via HTTP? — no, there's no endpoint. Instead, we wait for the next cron tick
 * (EVERY_MINUTE) and verify the outcome. To keep the test fast we also nudge
 * the sweeper via a small one-off ts-node script that imports and invokes it
 * directly using the same env/DB.
 *
 * Easiest path: use a bare knex pool to seed rows, then poll the same rows
 * until the cron flips them (≤ 70s per tick). The dev server already has the
 * worker scheduled.
 */
import knex from 'knex';
import { config as loadEnv } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
loadEnv();

const REGION = 'eg';

async function k() {
  return knex({
    client: 'pg',
    connection: {
      host: process.env.DB_eg_HOST,
      port: Number(process.env.DB_eg_PORT),
      user: process.env.DB_eg_USERNAME,
      password: process.env.DB_eg_PASSWORD,
      database: process.env.DB_eg_NAME,
    },
  });
}

async function seedOrder(db: any, opts: {
  ageMin: number;
  status?: string;
}): Promise<{ id: number; publicId: string; createdAt: Date }> {
  const publicId = uuidv4();
  const createdAt = new Date(Date.now() - opts.ageMin * 60 * 1000);
  const [row] = await db('orders')
    .insert({
      region: REGION,
      public_id: publicId,
      country_code: 'eg',
      restaurant_id: 1,
      branch_id: 1,
      customer_id: 5,
      customer_address_id: 1,
      delivery_lat: 30.0444,
      delivery_lng: 31.2357,
      delivery_address_text_snapshot: '12 Test St, Cairo, EG',
      status: opts.status ?? 'pending_payment',
      subtotal: 10000,
      delivery_fee: 1500,
      service_fee: 0,
      total: 11500,
      currency: 'EGP',
      payment_method: 'online',
      created_at: createdAt,
    })
    .returning(['id', 'created_at']);
  return { id: Number(row.id), publicId, createdAt: row.created_at };
}

async function seedSession(
  db: any,
  order: { id: number; createdAt: Date },
  opts: {
    expiresInMin: number; // negative = already expired
    status?: string;
  },
): Promise<number> {
  const expiresAt = new Date(Date.now() + opts.expiresInMin * 60 * 1000);
  const [row] = await db('payment_sessions')
    .insert({
      region: REGION,
      order_id: order.id,
      order_created_at: order.createdAt,
      provider_id: 2, // kashier
      provider_session_id: `sess_test_${order.id}_${Date.now()}`,
      redirect_url: 'https://kashier.test/session',
      amount: 11500,
      currency: 'EGP',
      status: opts.status ?? 'initialized',
      raw_init_payload: { test: true },
      expires_at: expiresAt,
    })
    .returning(['id']);
  return Number(row.id);
}

async function snapshot(db: any, orderId: number) {
  const order = await db('orders')
    .select('id', 'public_id', 'status', 'cancelled_at')
    .where('id', orderId)
    .first();
  const sessions = await db('payment_sessions')
    .select('id', 'status', 'expires_at')
    .where('order_id', orderId)
    .orderBy('id', 'asc');
  return { order, sessions };
}

async function main() {
  const db = await k();
  console.log('seeding…');
  const A = await seedOrder(db, { ageMin: 30 });
  await seedSession(db, A, { expiresInMin: -15 });
  const B = await seedOrder(db, { ageMin: 30 });
  // no session for B
  const C = await seedOrder(db, { ageMin: 2 });
  await seedSession(db, C, { expiresInMin: 13 });
  const D = await seedOrder(db, { ageMin: 30 });
  await seedSession(db, D, { expiresInMin: -10, status: 'failed' });
  const E = await seedOrder(db, { ageMin: 30, status: 'placed' });
  await seedSession(db, E, { expiresInMin: 10, status: 'captured' });

  const all = [
    { label: 'A stale session→expired,order→cancelled', o: A, expectOrder: 'cancelled' },
    { label: 'B no session,order→cancelled',           o: B, expectOrder: 'cancelled' },
    { label: 'C fresh, untouched',                    o: C, expectOrder: 'pending_payment' },
    { label: 'D failed session,order→cancelled',      o: D, expectOrder: 'cancelled' },
    { label: 'E already placed, untouched',           o: E, expectOrder: 'placed' },
  ];

  console.log('initial state:');
  for (const t of all) {
    const s = await snapshot(db, t.o.id);
    console.log(
      `  ${t.label.padEnd(45)} order(id=${t.o.id})=${s.order.status} sessions=${JSON.stringify(s.sessions.map((x: any) => ({ id: x.id, status: x.status })))}`,
    );
  }

  console.log('\nwaiting for next cron tick (up to 75s)…');
  const deadline = Date.now() + 75_000;
  let allMatch = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    let ok = true;
    for (const t of all) {
      const s = await snapshot(db, t.o.id);
      if (s.order.status !== t.expectOrder) { ok = false; break; }
    }
    if (ok) { allMatch = true; break; }
  }

  console.log('\nfinal state:');
  let pass = true;
  for (const t of all) {
    const s = await snapshot(db, t.o.id);
    const got = s.order.status;
    const passT = got === t.expectOrder;
    if (!passT) pass = false;
    console.log(
      `  ${passT ? 'PASS' : 'FAIL'} ${t.label.padEnd(45)} expected=${t.expectOrder} got=${got}`,
    );
    console.log(`       sessions: ${JSON.stringify(s.sessions.map((x: any) => ({ id: x.id, status: x.status })))}`);
  }
  console.log(pass ? '\nAll scenarios passed' : '\nFAILURES');
  if (!allMatch) console.log('(note: timed out before all matched expectations)');
  await db.destroy();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST ERROR:', e);
  process.exit(1);
});
