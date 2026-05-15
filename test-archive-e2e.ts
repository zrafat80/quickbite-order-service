/**
 * E2E Test: Nightly archival worker (implementation-plan Phase 6.2).
 *
 * Exercises the real `ArchivalWorker` against live Postgres clusters:
 *   - hot     = order_service_eg          (DB_eg_*)
 *   - archive = order_service_archive_eg  (ARCHIVE_DB_eg_* — same server/creds
 *                                          as hot, only the db name differs)
 *
 * Flow:
 *   1. Seed a small, fully-marked dataset into the HOT cluster:
 *        - 2 prior-year (2025) orders + their order_items / agent_earnings /
 *          payment_sessions / transactions
 *        - 1 prior-year payout transaction (order_id IS NULL)
 *        - 1 prior-year payment_webhook_events row
 *        - 1 current-year (2026) order + children + webhook event  (control —
 *          must NOT be archived)
 *   2. Run `ArchivalWorker.archiveOldData()`.
 *   3. Assert every prior-year row moved to the archive cluster and is gone
 *      from hot, and every current-year row stayed put.
 *   4. Clean up the seeded rows from both clusters.
 *
 * Run:  npx ts-node --transpile-only test-archive-e2e.ts
 */
import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
loadDotenv();

import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import type { Knex } from 'knex';
import appConfig from './src/lib/config/app.config';
import { buildShardedKnex, ShardedKnex } from './src/lib/sharding/shards';
import { ArchivalWorker } from './src/lib/jobs/archival.worker';

// ── fixed ids (far above the BIGSERIAL high-water mark, so no collision) ─────
const PRIOR_ORDER_IDS = [9_000_000_001, 9_000_000_002];
const CURRENT_ORDER_ID = 9_000_000_003;
const ALL_ORDER_IDS = [...PRIOR_ORDER_IDS, CURRENT_ORDER_ID];

const ITEM_IDS = [9_100_000_001, 9_100_000_002, 9_100_000_003];
const EARNING_IDS = [9_200_000_001, 9_200_000_002];
const SESSION_IDS = [9_300_000_001, 9_300_000_002];
const TX_ORDER_PRIOR = 9_400_000_001;
const TX_PAYOUT_PRIOR = 9_400_000_002;
const TX_ORDER_CURRENT = 9_400_000_003;
const ALL_TX_IDS = [TX_ORDER_PRIOR, TX_PAYOUT_PRIOR, TX_ORDER_CURRENT];
const WEBHOOK_PRIOR = 9_500_000_001;
const WEBHOOK_CURRENT = 9_500_000_002;
const ALL_WEBHOOK_IDS = [WEBHOOK_PRIOR, WEBHOOK_CURRENT];

const PRIOR_TS = '2025-06-15 10:00:00';   // before cutoff (start of 2026)
const CURRENT_TS = '2026-05-01 10:00:00'; // after cutoff — control row

const REGION = 'eg';

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}${detail ? ' — ' + detail : ''}`);
    pass++;
  } else {
    console.log(`  ❌ [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function countIn(db: Knex, table: string, col: string, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const [{ count }] = await db(table).whereIn(col, ids).count<{ count: string }[]>('* as count');
  return Number(count);
}

/** Delete the seeded rows from one cluster — children first, then orders. */
async function purge(db: Knex): Promise<void> {
  await db('order_items').whereIn('id', ITEM_IDS).delete();
  await db('agent_earnings').whereIn('id', EARNING_IDS).delete();
  await db('payment_sessions').whereIn('id', SESSION_IDS).delete();
  await db('transactions').whereIn('id', ALL_TX_IDS).delete();
  await db('payment_webhook_events').whereIn('id', ALL_WEBHOOK_IDS).delete();
  await db('orders').whereIn('id', ALL_ORDER_IDS).delete();
}

async function seedHot(hot: Knex): Promise<void> {
  // ── orders (2× prior-year, 1× current-year) ──
  const mkOrder = (id: number, createdAt: string) => ({
    id,
    region: REGION,
    public_id: randomUUID(),
    country_code: 'EG',
    restaurant_id: 3,
    branch_id: 3,
    customer_id: 5,
    customer_address_id: 1,
    delivery_lat: 29.9538,
    delivery_lng: 31.2634,
    delivery_address_text_snapshot: 'Street 9, Maadi, Cairo',
    status: 'delivered',
    subtotal: 4500,
    delivery_fee: 1500,
    service_fee: 0,
    total: 6000,
    commission: 300,
    currency: 'EGP',
    payment_method: 'cod',
    created_at: createdAt,
    updated_at: createdAt,
  });
  await hot('orders').insert([
    mkOrder(PRIOR_ORDER_IDS[0], PRIOR_TS),
    mkOrder(PRIOR_ORDER_IDS[1], PRIOR_TS),
    mkOrder(CURRENT_ORDER_ID, CURRENT_TS),
  ]);

  // ── order_items (one per order; order_created_at mirrors the parent) ──
  const mkItem = (id: number, orderId: number, orderCreatedAt: string) => ({
    id,
    region: REGION,
    order_id: orderId,
    order_created_at: orderCreatedAt,
    product_id: 1,
    quantity: 1,
    unit_price_snapshot: 4500,
    name_snapshot: 'Koshary',
    line_total: 4500,
    created_at: orderCreatedAt,
  });
  await hot('order_items').insert([
    mkItem(ITEM_IDS[0], PRIOR_ORDER_IDS[0], PRIOR_TS),
    mkItem(ITEM_IDS[1], PRIOR_ORDER_IDS[1], PRIOR_TS),
    mkItem(ITEM_IDS[2], CURRENT_ORDER_ID, CURRENT_TS),
  ]);

  // ── agent_earnings (prior-year orders only) ──
  await hot('agent_earnings').insert([
    {
      id: EARNING_IDS[0], region: REGION, agent_id: 48,
      order_id: PRIOR_ORDER_IDS[0], order_created_at: PRIOR_TS,
      amount: 1200, currency: 'EGP', earned_at: PRIOR_TS,
    },
    {
      id: EARNING_IDS[1], region: REGION, agent_id: 48,
      order_id: PRIOR_ORDER_IDS[1], order_created_at: PRIOR_TS,
      amount: 1200, currency: 'EGP', earned_at: PRIOR_TS,
    },
  ]);

  // ── payment_sessions (prior-year orders only) ──
  const mkSession = (id: number, orderId: number) => ({
    id, region: REGION, order_id: orderId, order_created_at: PRIOR_TS,
    provider_id: 1, provider_session_id: `sess-archive-e2e-${id}`,
    redirect_url: 'https://test-api.kashier.io/pay/x', amount: 6000,
    currency: 'EGP', status: 'captured',
    raw_init_payload: JSON.stringify({ seeded: true }),
    created_at: PRIOR_TS, updated_at: PRIOR_TS,
  });
  await hot('payment_sessions').insert([
    mkSession(SESSION_IDS[0], PRIOR_ORDER_IDS[0]),
    mkSession(SESSION_IDS[1], PRIOR_ORDER_IDS[1]),
  ]);

  // ── transactions: prior order-tied charge, prior payout (no order), current charge ──
  await hot('transactions').insert([
    {
      id: TX_ORDER_PRIOR, region: REGION,
      order_id: PRIOR_ORDER_IDS[0], order_created_at: PRIOR_TS,
      transaction_type: 'charge', method: 'cod', status: 'succeeded',
      amount: 6000, currency: 'EGP', created_at: PRIOR_TS, updated_at: PRIOR_TS,
    },
    {
      // payout — order_id IS NULL, filtered on its own created_at
      id: TX_PAYOUT_PRIOR, region: REGION,
      order_id: null, order_created_at: null,
      transaction_type: 'payout', method: 'bank_transfer', status: 'succeeded',
      amount: 5000, currency: 'EGP', created_at: PRIOR_TS, updated_at: PRIOR_TS,
    },
    {
      id: TX_ORDER_CURRENT, region: REGION,
      order_id: CURRENT_ORDER_ID, order_created_at: CURRENT_TS,
      transaction_type: 'charge', method: 'cod', status: 'succeeded',
      amount: 6000, currency: 'EGP', created_at: CURRENT_TS, updated_at: CURRENT_TS,
    },
  ]);

  // ── payment_webhook_events (filtered on received_at) ──
  await hot('payment_webhook_events').insert([
    {
      id: WEBHOOK_PRIOR, region: REGION, provider_id: 1,
      provider_event_id: `evt-archive-e2e-${WEBHOOK_PRIOR}`,
      event_type: 'pay', payload: JSON.stringify({ seeded: true }),
      received_at: PRIOR_TS,
    },
    {
      id: WEBHOOK_CURRENT, region: REGION, provider_id: 1,
      provider_event_id: `evt-archive-e2e-${WEBHOOK_CURRENT}`,
      event_type: 'pay', payload: JSON.stringify({ seeded: true }),
      received_at: CURRENT_TS,
    },
  ]);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  E2E: Archival worker — prior-year hot → archive move');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const cfg = appConfig();
  console.log(`  hot DB     = ${cfg.hotShards[REGION]?.name}`);
  console.log(`  archive DB = ${cfg.archiveShards[REGION]?.name}`);
  if (!cfg.archiveShards[REGION]) {
    console.error('  FATAL: ARCHIVE_DB_eg_* env not configured — aborting.');
    process.exit(1);
  }

  const knex: ShardedKnex = buildShardedKnex({
    hot: cfg.hotShards,
    archive: cfg.archiveShards,
    poolMax: cfg.db.poolMax,
    migrations: {
      directory: cfg.db.migrationDirectory,
      extension: cfg.db.migrationExtension,
    },
  });
  const redis = new Redis({
    host: cfg.redis.host,
    port: cfg.redis.port,
    password: cfg.redis.password,
  });
  const configService = new ConfigService(cfg as Record<string, unknown>);

  const hot = knex.db(REGION);
  const archive = knex.dbArchive(REGION);

  try {
    // ── connectivity ──
    await hot.raw('SELECT 1');
    await archive.raw('SELECT 1');
    assert('Connected to hot + archive clusters', true);

    // ── clean any leftovers from a previous run, then seed ──
    await purge(hot);
    await purge(archive);
    await redis.del(`archival:${REGION}:lock`);

    console.log('\nStep 1 — Seed hot cluster (2 prior-year orders + 1 current-year control)');
    await seedHot(hot);
    assert('Seeded 3 orders into hot', await countIn(hot, 'orders', 'id', ALL_ORDER_IDS) === 3);
    assert('Seeded 3 order_items into hot', await countIn(hot, 'order_items', 'id', ITEM_IDS) === 3);
    assert('Seeded 2 agent_earnings into hot', await countIn(hot, 'agent_earnings', 'id', EARNING_IDS) === 2);
    assert('Seeded 2 payment_sessions into hot', await countIn(hot, 'payment_sessions', 'id', SESSION_IDS) === 2);
    assert('Seeded 3 transactions into hot', await countIn(hot, 'transactions', 'id', ALL_TX_IDS) === 3);
    assert('Seeded 2 webhook events into hot', await countIn(hot, 'payment_webhook_events', 'id', ALL_WEBHOOK_IDS) === 2);

    // ── run the real worker ──
    console.log('\nStep 2 — Run ArchivalWorker.archiveOldData()');
    const worker = new ArchivalWorker(knex, redis as any, configService);
    const startedAt = Date.now();
    await worker.archiveOldData();
    console.log(`  worker run finished in ${Date.now() - startedAt}ms`);

    // ── verify: prior-year rows moved, current-year rows untouched ──
    console.log('\nStep 3 — Verify prior-year rows moved to the archive cluster');
    assert('Prior orders removed from hot',
      await countIn(hot, 'orders', 'id', PRIOR_ORDER_IDS) === 0);
    assert('Prior orders present in archive',
      await countIn(archive, 'orders', 'id', PRIOR_ORDER_IDS) === 2);

    assert('Prior order_items removed from hot',
      await countIn(hot, 'order_items', 'id', [ITEM_IDS[0], ITEM_IDS[1]]) === 0);
    assert('Prior order_items present in archive',
      await countIn(archive, 'order_items', 'id', [ITEM_IDS[0], ITEM_IDS[1]]) === 2);

    assert('agent_earnings removed from hot',
      await countIn(hot, 'agent_earnings', 'id', EARNING_IDS) === 0);
    assert('agent_earnings present in archive',
      await countIn(archive, 'agent_earnings', 'id', EARNING_IDS) === 2);

    assert('payment_sessions removed from hot',
      await countIn(hot, 'payment_sessions', 'id', SESSION_IDS) === 0);
    assert('payment_sessions present in archive',
      await countIn(archive, 'payment_sessions', 'id', SESSION_IDS) === 2);

    assert('Prior order-tied transaction removed from hot',
      await countIn(hot, 'transactions', 'id', [TX_ORDER_PRIOR]) === 0);
    assert('Prior order-tied transaction present in archive',
      await countIn(archive, 'transactions', 'id', [TX_ORDER_PRIOR]) === 1);
    assert('Prior payout transaction (order_id NULL) removed from hot',
      await countIn(hot, 'transactions', 'id', [TX_PAYOUT_PRIOR]) === 0);
    assert('Prior payout transaction present in archive',
      await countIn(archive, 'transactions', 'id', [TX_PAYOUT_PRIOR]) === 1);

    assert('Prior webhook event removed from hot',
      await countIn(hot, 'payment_webhook_events', 'id', [WEBHOOK_PRIOR]) === 0);
    assert('Prior webhook event present in archive',
      await countIn(archive, 'payment_webhook_events', 'id', [WEBHOOK_PRIOR]) === 1);

    console.log('\nStep 4 — Verify current-year rows were left in the hot cluster');
    assert('Current-year order still in hot',
      await countIn(hot, 'orders', 'id', [CURRENT_ORDER_ID]) === 1);
    assert('Current-year order NOT in archive',
      await countIn(archive, 'orders', 'id', [CURRENT_ORDER_ID]) === 0);
    assert('Current-year order_item still in hot',
      await countIn(hot, 'order_items', 'id', [ITEM_IDS[2]]) === 1);
    assert('Current-year order_item NOT in archive',
      await countIn(archive, 'order_items', 'id', [ITEM_IDS[2]]) === 0);
    assert('Current-year transaction still in hot',
      await countIn(hot, 'transactions', 'id', [TX_ORDER_CURRENT]) === 1);
    assert('Current-year webhook event still in hot',
      await countIn(hot, 'payment_webhook_events', 'id', [WEBHOOK_CURRENT]) === 1);

    // ── idempotency: a second run is a clean no-op ──
    console.log('\nStep 5 — Re-run the worker (idempotency check)');
    await worker.archiveOldData();
    assert('Re-run kept archive prior orders at 2 (no duplicates)',
      await countIn(archive, 'orders', 'id', PRIOR_ORDER_IDS) === 2);
    assert('Re-run left current-year order in hot',
      await countIn(hot, 'orders', 'id', [CURRENT_ORDER_ID]) === 1);
  } catch (err) {
    console.error('\nFATAL:', err);
    fail++;
  } finally {
    console.log('\nStep 6 — Clean up seeded rows from both clusters');
    try {
      await purge(hot);
      await purge(archive);
      await redis.del(`archival:${REGION}:lock`);
      console.log('  cleaned up');
    } catch (e) {
      console.error('  cleanup error:', (e as Error).message);
    }
    await knex.destroyAll();
    redis.disconnect();
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Summary: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

run();
