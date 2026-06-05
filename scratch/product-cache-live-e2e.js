const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const amqp = require('amqplib');
const Redis = require('ioredis');

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx);
    let value = trimmed.slice(idx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const root = path.resolve(__dirname, '..');
const orderEnv = loadEnv(path.join(root, '.env'));
const coreEnv = loadEnv(path.join(root, '..', 'core-service', 'backend', '.env'));
const env = { ...coreEnv, ...orderEnv, ...process.env };

const coreBaseUrl = env.CORE_SERVICE_BASE_URL || `http://localhost:${coreEnv.PORT || 3000}`;
const apiKey = coreEnv.INTERNAL_API_KEY || env.CORE_INTERNAL_API_KEY || env.INTERNAL_API_KEY;
const orderQueue = env.RABBITMQ_CORE_EVENTS_QUEUE || 'order-service.core-events';

function coreDb() {
  return new Client({
    host: coreEnv.DB_HOST || 'localhost',
    port: Number(coreEnv.DB_PORT || 5432),
    user: coreEnv.DB_USERNAME || 'postgres',
    password: coreEnv.DB_PASSWORD || '',
    database: coreEnv.DB_DATABASE || 'postgres',
  });
}

function redis() {
  return new Redis({
    host: orderEnv.REDIS_HOST || 'localhost',
    port: Number(orderEnv.REDIS_PORT || 6379),
    password: orderEnv.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 1,
  });
}

async function pickProduct(db) {
  const res = await db.query(`
    SELECT pbd.branch_id, pbd.product_id, pbd.stock
    FROM product_branch_details pbd
    JOIN products p ON p.id = pbd.product_id
    WHERE p.deleted_at IS NULL
      AND pbd.is_available = true
      AND pbd.stock >= 1
    ORDER BY pbd.stock DESC, pbd.branch_id ASC, pbd.product_id ASC
    LIMIT 1
  `);
  if (res.rows.length === 0) {
    throw new Error('no available branch product with stock >= 1');
  }
  return {
    branchId: Number(res.rows[0].branch_id),
    productId: Number(res.rows[0].product_id),
    stock: Number(res.rows[0].stock),
  };
}

async function callCore(method, pathPart, body, idemKey) {
  const headers = {
    'x-api-key': apiKey,
    'content-type': 'application/json',
  };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  const res = await fetch(`${coreBaseUrl}${pathPart}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathPart} -> ${res.status}: ${text}`);
  }
  return parsed;
}

async function latestStockEvent(db, aggregateId, afterEventId) {
  const params = [aggregateId];
  let sql = `
    SELECT event_id, dispatched_at
    FROM events_outbox
    WHERE event_type = 'product.stock.changed'
      AND aggregate_id = $1
  `;
  if (afterEventId) {
    params.push(afterEventId);
    sql += ` AND event_id <> $2`;
  }
  sql += ` ORDER BY id DESC LIMIT 1`;
  const res = await db.query(sql, params);
  return res.rows[0] || null;
}

async function waitFor(fn, label, timeoutMs = 10000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function queueStats() {
  const conn = await amqp.connect(env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
  const ch = await conn.createChannel();
  try {
    return await ch.checkQueue(orderQueue);
  } finally {
    await ch.close().catch(() => {});
    await conn.close().catch(() => {});
  }
}

async function waitEventDispatchedAndConsumed(db, redisClient, aggregateId, afterEventId) {
  const event = await waitFor(async () => {
    const row = await latestStockEvent(db, aggregateId, afterEventId);
    return row && row.dispatched_at ? row : null;
  }, `outbox dispatch for ${aggregateId}`);

  await waitFor(
    async () => {
      const exists = await redisClient.exists(`core-events:dedupe:${event.event_id}`);
      return exists === 1;
    },
    `order-service consume/dedupe for ${event.event_id}`,
  );
  return event;
}

async function main() {
  if (!apiKey) throw new Error('missing core internal API key');

  const db = coreDb();
  const redisClient = redis();
  await db.connect();

  try {
    const product = await pickProduct(db);
    const aggregateId = `${product.branchId}:${product.productId}`;
    const beforeQueue = await queueStats();

    const fetched = await callCore(
      'GET',
      `/api/internal/branches/${product.branchId}/products?ids=${product.productId}`,
    );
    if (!fetched?.data || fetched.data.length !== 1) {
      throw new Error('internal product lookup did not return exactly one product');
    }

    await callCore(
      'POST',
      `/api/internal/branches/${product.branchId}/reserve-stock`,
      { items: [{ productId: product.productId, quantity: 1 }] },
      `codex-reserve-${Date.now()}`,
    );
    const reserveEvent = await waitEventDispatchedAndConsumed(
      db,
      redisClient,
      aggregateId,
    );

    await callCore(
      'POST',
      `/api/internal/branches/${product.branchId}/release-stock`,
      { items: [{ productId: product.productId, quantity: 1 }] },
      `codex-release-${Date.now()}`,
    );
    const releaseEvent = await waitEventDispatchedAndConsumed(
      db,
      redisClient,
      aggregateId,
      reserveEvent.event_id,
    );

    const afterQueue = await queueStats();
    console.log(
      [
        'PRODUCT_E2E_OK',
        `branchId=${product.branchId}`,
        `productId=${product.productId}`,
        `queueBefore=${beforeQueue.messageCount}`,
        `queueAfter=${afterQueue.messageCount}`,
        `consumers=${afterQueue.consumerCount}`,
        `reserveEvent=${reserveEvent.event_id}`,
        `releaseEvent=${releaseEvent.event_id}`,
      ].join(' '),
    );
  } finally {
    await redisClient.quit().catch(() => {});
    await db.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
