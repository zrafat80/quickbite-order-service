/**
 * Cross-service e2e for the meta/stock cache split.
 *
 * Drives a REAL event through the production plumbing end-to-end:
 *   1. Pre-populate productMeta + productStock keys in order-service's Redis.
 *   2. Insert a `product.meta.changed` row directly into core-service's
 *      events_outbox (simulating what ProductService.update() does inside the
 *      domain trx).
 *   3. core-service's drainer (2s tick) publishes it to RabbitMQ.
 *   4. order-service's CoreEventsConsumer picks it up and runs the handler.
 *   5. Poll Redis: productMeta should disappear within ~3-5s; productStock
 *      must stay (split projection invariant).
 *
 * Requires core-service AND order-service running, plus RabbitMQ + Redis.
 *
 * Usage:  npx ts-node play/test-cross-service-meta-event.ts <branchId> <productId>
 */
import knex from 'knex';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';
loadEnv();

const BRANCH_ID = Number(process.argv[2] ?? 1);
const PRODUCT_ID = Number(process.argv[3] ?? 1);
const META_KEY = `core:product:meta:${BRANCH_ID}:${PRODUCT_ID}`;
const STOCK_KEY = `core:product:stock:${BRANCH_ID}:${PRODUCT_ID}`;
const DEADLINE_MS = 8000;

type Scenario = {
  name: string;
  eventType: 'product.meta.changed' | 'product.price.changed' | 'product.stock.changed';
  expect: { metaSurvives: boolean; stockSurvives: boolean };
};

const SCENARIOS: Scenario[] = [
  { name: 'product.meta.changed',  eventType: 'product.meta.changed',  expect: { metaSurvives: false, stockSurvives: true } },
  { name: 'product.price.changed', eventType: 'product.price.changed', expect: { metaSurvives: false, stockSurvives: true } },
  { name: 'product.stock.changed', eventType: 'product.stock.changed', expect: { metaSurvives: true,  stockSurvives: false } },
];

async function primeBoth(redis: Redis): Promise<void> {
  await redis.set(META_KEY, JSON.stringify({ productId: PRODUCT_ID, name: 'Pre-event', price: 100, imageUrl: null, isAvailable: true }), 'EX', 3600);
  await redis.set(STOCK_KEY, '42', 'EX', 3600);
}

async function runScenario(coreDb: any, redis: Redis, s: Scenario): Promise<boolean> {
  console.log(`\n── ${s.name} ──`);
  await primeBoth(redis);
  const eventId = randomUUID();
  await coreDb('events_outbox').insert({
    aggregate_type: 'product_branch_details',
    aggregate_id: `${BRANCH_ID}:${PRODUCT_ID}`,
    event_type: s.eventType,
    event_id: eventId,
    payload: JSON.stringify({ branchId: BRANCH_ID, productId: PRODUCT_ID }),
  });
  const start = Date.now();
  while (Date.now() - start < DEADLINE_MS) {
    const [m, st] = await Promise.all([redis.exists(META_KEY), redis.exists(STOCK_KEY)]);
    const metaPresent = m === 1;
    const stockPresent = st === 1;
    // Wait until the side we expect to be deleted is actually gone, OR
    // the deadline expires (we'll then check final state).
    if (
      metaPresent === s.expect.metaSurvives &&
      stockPresent === s.expect.stockSurvives
    ) {
      const elapsed = Date.now() - start;
      console.log(`+${elapsed}ms  meta=${metaPresent} stock=${stockPresent}  → as expected`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const [m, st] = await Promise.all([redis.exists(META_KEY), redis.exists(STOCK_KEY)]);
  console.log(`FAIL: after ${DEADLINE_MS}ms — meta=${m === 1} stock=${st === 1}, expected meta=${s.expect.metaSurvives} stock=${s.expect.stockSurvives}`);
  return false;
}

async function main() {
  const coreDb = knex({
    client: 'pg',
    connection: {
      host: process.env.CORE_DB_HOST || 'localhost',
      port: Number(process.env.CORE_DB_PORT || 5432),
      user: process.env.CORE_DB_USERNAME || 'postgres',
      password: process.env.CORE_DB_PASSWORD || 'zeyiad123123',
      database: process.env.CORE_DB_DATABASE || 'myfirst',
    },
  });
  const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  });

  console.log(`branch=${BRANCH_ID} product=${PRODUCT_ID}`);

  let allPass = true;
  for (const s of SCENARIOS) {
    const ok = await runScenario(coreDb, redis, s);
    if (!ok) allPass = false;
  }

  await coreDb.destroy();
  await redis.quit();
  console.log(`\n──── ${allPass ? 'ALL PASS' : 'FAILED'} ────`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
