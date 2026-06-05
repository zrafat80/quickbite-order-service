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
const orderBaseUrl = `http://localhost:${orderEnv.PORT || 4000}`;
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

function orderDb(region) {
  return new Client({
    host: orderEnv[`DB_${region}_HOST`] || 'localhost',
    port: Number(orderEnv[`DB_${region}_PORT`] || 5432),
    user: orderEnv[`DB_${region}_USERNAME`] || 'postgres',
    password: orderEnv[`DB_${region}_PASSWORD`] || '',
    database: orderEnv[`DB_${region}_NAME`] || `order_service_${region}`,
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

function unwrap(json) {
  if (json && typeof json === 'object' && 'data' in json) return json.data;
  return json;
}

async function httpJson(method, url, { body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  }
  return {
    json,
    data: unwrap(json),
    setCookie: res.headers.get('set-cookie') || '',
  };
}

function accessCookie(resp) {
  const fromBody = resp.data?.accessToken || resp.json?.accessToken;
  if (fromBody) return `access_token=${fromBody}`;

  const match = resp.setCookie.match(/access_token=([^;]+)/);
  if (match) return `access_token=${match[1]}`;
  throw new Error('register response did not contain access token');
}

async function pickCheckoutProduct(db) {
  const res = await db.query(`
    SELECT
      pbd.branch_id,
      pbd.product_id,
      pbd.stock,
      b.country_code
    FROM product_branch_details pbd
    JOIN products p ON p.id = pbd.product_id
    JOIN restaurant_branches b ON b.id = pbd.branch_id
    JOIN restaurants r ON r.id = b.restaurant_id
    WHERE p.deleted_at IS NULL
      AND pbd.is_available = true
      AND pbd.stock >= 1
      AND b.is_active = true
      AND b.accept_orders = true
      AND r.status = 'active'
    ORDER BY pbd.stock DESC, pbd.branch_id ASC, pbd.product_id ASC
    LIMIT 1
  `);
  if (res.rows.length === 0) {
    throw new Error('no checkout-ready branch product found');
  }
  return {
    branchId: Number(res.rows[0].branch_id),
    productId: Number(res.rows[0].product_id),
    region: String(res.rows[0].country_code || 'eg').toLowerCase(),
    stock: Number(res.rows[0].stock),
  };
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

async function waitFor(fn, label, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
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
  }, `core outbox dispatch for ${aggregateId}`);

  await waitFor(
    async () => (await redisClient.exists(`core-events:dedupe:${event.event_id}`)) === 1,
    `order-service consume/dedupe for ${event.event_id}`,
  );
  return event;
}

async function findOrder(orderClient, publicId) {
  const res = await orderClient.query(
    `SELECT id, public_id, status FROM orders WHERE public_id = $1 LIMIT 1`,
    [publicId],
  );
  return res.rows[0] || null;
}

async function main() {
  const core = coreDb();
  const redisClient = redis();
  await core.connect();

  let order = null;
  try {
    const product = await pickCheckoutProduct(core);
    const aggregateId = `${product.branchId}:${product.productId}`;
    order = orderDb(product.region);
    await order.connect();

    const now = Date.now();
    const email = `codex.checkout.${now}@example.com`;
    const password = 'CodexPass1';

    const beforeQueue = await queueStats();
    const beforeEvent = await latestStockEvent(core, aggregateId);

    const registered = await httpJson('POST', `${coreBaseUrl}/api/auth/register`, {
      headers: { 'Idempotency-Key': `codex-register-${now}` },
      body: {
        email,
        phone: `10${String(now).slice(-8)}`,
        name: 'Codex Checkout Customer',
        password,
        role: 'customer',
      },
    });
    const cookie = accessCookie(registered);
    const userId = Number(registered.data?.user?.id || registered.data?.userId);

    const addressResp = await httpJson(
      'POST',
      `${coreBaseUrl}/api/customer/addresses`,
      {
        headers: { Cookie: cookie },
        body: {
          label: 'Checkout Test',
          country: 'Egypt',
          city: 'Cairo',
          street: 'Tahrir Street',
          building: '1',
          apartmentNumber: '1',
          type: 'home',
          lat: 30.0444,
          lng: 31.2357,
          isDefault: true,
        },
      },
    );
    const addressId = Number(
      addressResp.data?.id ||
        addressResp.data?.address?.id ||
        addressResp.data?.data?.id ||
        addressResp.data?.data?.address?.id,
    );
    if (!addressId) throw new Error('address creation did not return an id');

    const orderResp = await httpJson('POST', `${orderBaseUrl}/api/orders`, {
      headers: {
        Cookie: cookie,
        'Idempotency-Key': `codex-order-${now}`,
        'X-Region': product.region,
      },
      body: {
        branchId: product.branchId,
        customerAddressId: addressId,
        paymentMethod: 'cod',
        items: [{ productId: product.productId, quantity: 1 }],
      },
    });
    const orderData = orderResp.data;
    const publicId = orderData?.publicId || orderData?.orderId || orderData?.id;
    if (!publicId) {
      throw new Error(`order response did not include public id: ${JSON.stringify(orderResp.json)}`);
    }

    const dbOrder = await waitFor(
      () => findOrder(order, publicId),
      `order row ${publicId}`,
    );
    const event = await waitEventDispatchedAndConsumed(
      core,
      redisClient,
      aggregateId,
      beforeEvent?.event_id,
    );
    const afterQueue = await queueStats();

    console.log(
      [
        'FULL_CHECKOUT_E2E_OK',
        `userId=${userId || 'unknown'}`,
        `addressId=${addressId}`,
        `branchId=${product.branchId}`,
        `productId=${product.productId}`,
        `region=${product.region}`,
        `orderPublicId=${publicId}`,
        `orderStatus=${dbOrder.status}`,
        `stockEvent=${event.event_id}`,
        `queueBefore=${beforeQueue.messageCount}`,
        `queueAfter=${afterQueue.messageCount}`,
        `consumers=${afterQueue.consumerCount}`,
      ].join(' '),
    );
  } finally {
    await redisClient.quit().catch(() => {});
    await order?.end().catch(() => {});
    await core.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
