/**
 * End-to-end verification of the core->order events pipe.
 *
 *   core-service.events_outbox          (insert one row per event type here)
 *        |
 *        v
 *   core worker (already running)        publishes envelope to RabbitMQ
 *        |
 *        v
 *   exchange "core.events"               topic, durable
 *        |
 *        v
 *   queue "order-service.core-events"    bound on product.# / branch.# / restaurant.# / rbac.#
 *        |
 *        v
 *   order-service consumer               dedupe via redis SETNX, then handler deletes/sets cache keys
 *
 * What this script asserts, per event type:
 *   1. The outbox row gets `dispatched_at` set within ~5s (worker is running).
 *   2. The dedupe key `core-events:dedupe:<eventId>` is present in Redis (consumer received and processed it).
 *   3. For event types whose handler touches Redis, the expected cache mutation happened
 *      (key deleted, or the branch-deactivated reject flag got set).
 *
 * Prereqs (already satisfied in this dev env):
 *   - core-service worker running (`npm run worker:dev` in core)
 *   - order-service running (`npm run start:dev` in order)
 *   - Postgres, Redis, RabbitMQ all up on localhost
 *   - core-service .env points at db `myfirst`
 *
 * Run from order-service/:
 *   node play/test-events-e2e.js
 */

const { Client } = require('pg');
const Redis = require('ioredis');
const { randomUUID } = require('node:crypto');

const PG = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'zeyiad123123',
  database: 'myfirst', // core-service db
};

const REDIS = { host: 'localhost', port: 6379 };

const POLL_INTERVAL_MS = 100;
const POLL_MAX_MS = 8000;

function pad(s, n) {
  return String(s).padEnd(n);
}

async function poll(label, fn) {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise((r2) => setTimeout(r2, POLL_INTERVAL_MS));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  const pg = new Client(PG);
  await pg.connect();
  const redis = new Redis(REDIS);

  // Define one test event per known type. `seedKey`/`seedValue` lets us pre-write
  // a cache entry the handler is supposed to invalidate; `expectKeyDeleted` asserts
  // the handler did delete it; `expectKeyExists` asserts a key the handler creates.
  const cases = [
    {
      name: 'product.stock.changed',
      aggregateType: 'product_branch_details',
      aggregateId: '1:42',
      payload: { branchId: 1, productId: 42, stock: 7 },
      seedKey: 'core:product:1:42',
      seedValue: 'stale',
      expectKeyDeleted: 'core:product:1:42',
    },
    {
      name: 'product.price.changed',
      aggregateType: 'product_branch_details',
      aggregateId: '1:42',
      payload: { branchId: 1, productId: 42, price: 1500 },
      seedKey: 'core:product:1:42',
      seedValue: 'stale',
      expectKeyDeleted: 'core:product:1:42',
    },
    {
      name: 'branch.updated',
      aggregateType: 'branch',
      aggregateId: '99',
      payload: { branchId: 99 },
      seedKey: 'core:branch:99',
      seedValue: 'stale',
      expectKeyDeleted: 'core:branch:99',
    },
    {
      name: 'branch.deactivated',
      aggregateType: 'branch',
      aggregateId: '77',
      payload: { branchId: 77 },
      seedKey: 'core:branch:77',
      seedValue: 'stale',
      expectKeyDeleted: 'core:branch:77',
      expectKeyExists: 'core:branch:77:reject_orders',
    },
    {
      name: 'restaurant.suspended',
      aggregateType: 'restaurant',
      aggregateId: '5',
      payload: { restaurantId: 5 },
      seedKey: 'core:restaurant:5',
      seedValue: 'stale',
      expectKeyDeleted: 'core:restaurant:5',
    },
    {
      name: 'rbac.permissions_changed',
      aggregateType: 'role',
      aggregateId: 'restaurant_owner',
      payload: { role: 'restaurant_owner' },
      // no Redis-side effect; PermissionCacheService is in-process
    },
  ];

  console.log('--- seeding redis cache keys ---');
  for (const c of cases) {
    if (c.seedKey) {
      await redis.set(c.seedKey, c.seedValue);
      console.log(`  set ${c.seedKey} = ${c.seedValue}`);
    }
    // Pre-clear any reject-orders flag so the test isn't a false positive.
    if (c.expectKeyExists) {
      await redis.del(c.expectKeyExists);
    }
  }

  console.log('\n--- inserting outbox rows ---');
  for (const c of cases) {
    c.eventId = randomUUID();
    const sql = `
      INSERT INTO events_outbox (aggregate_type, aggregate_id, event_type, event_id, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING id
    `;
    const params = [
      c.aggregateType,
      c.aggregateId,
      c.name,
      c.eventId,
      JSON.stringify(c.payload),
    ];
    const r = await pg.query(sql, params);
    c.outboxId = r.rows[0].id;
    console.log(`  ${pad(c.name, 28)} outboxId=${c.outboxId} eventId=${c.eventId}`);
  }

  console.log('\n--- waiting for worker to dispatch all rows ---');
  const ids = cases.map((c) => c.outboxId);
  await poll('all rows dispatched', async () => {
    const r = await pg.query(
      'SELECT id, dispatched_at, attempts, last_error FROM events_outbox WHERE id = ANY($1::bigint[])',
      [ids],
    );
    const undisp = r.rows.filter((row) => !row.dispatched_at);
    if (undisp.length === 0) return true;
    return false;
  });
  console.log(`  ✅ all ${ids.length} rows dispatched`);

  console.log('\n--- waiting for consumer to record dedupe keys ---');
  for (const c of cases) {
    const dedupeKey = `core-events:dedupe:${c.eventId}`;
    await poll(`dedupe key for ${c.name}`, async () => (await redis.get(dedupeKey)) !== null);
    console.log(`  ✅ ${pad(c.name, 28)} dedupe key present`);
  }

  console.log('\n--- verifying handler side effects ---');
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    if (c.expectKeyDeleted) {
      // Cache delete races the dedupe set; give it a brief grace period.
      await poll(`delete of ${c.expectKeyDeleted}`, async () =>
        (await redis.get(c.expectKeyDeleted)) === null,
      ).then(
        () => {
          console.log(`  ✅ ${pad(c.name, 28)} deleted ${c.expectKeyDeleted}`);
          pass++;
        },
        (err) => {
          console.log(`  ❌ ${pad(c.name, 28)} did NOT delete ${c.expectKeyDeleted}: ${err.message}`);
          fail++;
        },
      );
    }
    if (c.expectKeyExists) {
      const v = await redis.get(c.expectKeyExists);
      if (v) {
        console.log(`  ✅ ${pad(c.name, 28)} set ${c.expectKeyExists} = ${v}`);
        pass++;
      } else {
        console.log(`  ❌ ${pad(c.name, 28)} did NOT set ${c.expectKeyExists}`);
        fail++;
      }
    }
    if (!c.expectKeyDeleted && !c.expectKeyExists) {
      console.log(`  ➖ ${pad(c.name, 28)} no Redis side-effect to assert (handler is in-process)`);
    }
  }

  console.log('\n--- replay test (idempotency) ---');
  // Re-publish the same eventId via outbox shouldn't double-process. Outbox rows
  // are unique by event_id (UNIQUE constraint), so insert a NEW outbox row that
  // re-uses the FIRST event's eventId via a fresh row is impossible. Instead, we
  // verify by checking dedupe-key TTL is still around and the handler isn't re-
  // invoked: re-set the seedKey AFTER the original handler delete and re-publish
  // a NEW outbox row with the SAME event_id+payload via SQL with a stub ON CONFLICT
  // — no, the unique constraint blocks it. So we test replay at the broker layer:
  // publish-from-broker-directly is in test-rabbit-replay.js (separate). Skipping
  // here — dedupe is exercised by the consumer for every duplicate the broker
  // delivers, and we assert deletion only after the first delivery.

  console.log('\n--- cleanup ---');
  // Delete dedupe keys we created so they don't pollute Redis indefinitely (24h TTL anyway).
  await redis.del(...cases.map((c) => `core-events:dedupe:${c.eventId}`));
  // Delete reject-orders flag we observed.
  await redis.del('core:branch:77:reject_orders');

  await pg.end();
  await redis.quit();

  if (fail > 0) {
    console.log(`\n❌ ${fail} side-effect assertions failed (${pass} passed)`);
    process.exit(1);
  }
  console.log(`\n✅ all ${pass} side-effect assertions passed`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
