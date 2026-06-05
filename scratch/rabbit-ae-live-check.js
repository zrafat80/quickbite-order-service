const fs = require('fs');
const path = require('path');
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

const cfg = {
  url: env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  exchange: env.RABBITMQ_CORE_EVENTS_EXCHANGE || 'core.events',
  alternateExchange: env.RABBITMQ_CORE_EVENTS_AE || 'core.events.unroutable',
  alternateQueue:
    env.RABBITMQ_CORE_EVENTS_UNROUTABLE_QUEUE || 'core.events.unroutable.dlq',
  orderQueue: env.RABBITMQ_CORE_EVENTS_QUEUE || 'order-service.core-events',
  orderBindings: (env.RABBITMQ_CORE_EVENTS_BINDINGS ||
    'product.#,branch.#,restaurant.#,rbac.#')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  dlx: env.RABBITMQ_CORE_EVENTS_DLX || 'core.events.dlx',
  dlq: env.RABBITMQ_CORE_EVENTS_DLQ || 'order-service.core-events.dlq',
  redisHost: env.REDIS_HOST || 'localhost',
  redisPort: Number(env.REDIS_PORT || 6379),
  redisPassword: env.REDIS_PASSWORD || undefined,
};

async function connect() {
  const conn = await amqp.connect(cfg.url);
  const ch = await conn.createConfirmChannel();
  return { conn, ch };
}

async function assertTopology(ch) {
  await ch.assertExchange(cfg.alternateExchange, 'fanout', { durable: true });
  await ch.assertQueue(cfg.alternateQueue, { durable: true });
  await ch.bindQueue(cfg.alternateQueue, cfg.alternateExchange, '');

  await ch.assertExchange(cfg.exchange, 'topic', {
    durable: true,
    arguments: { 'alternate-exchange': cfg.alternateExchange },
  });

  await ch.assertExchange(cfg.dlx, 'topic', { durable: true });
  await ch.assertQueue(cfg.dlq, { durable: true });
  await ch.bindQueue(cfg.dlq, cfg.dlx, '#');

  await ch.assertQueue(cfg.orderQueue, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': cfg.dlx },
  });
  for (const binding of cfg.orderBindings) {
    await ch.bindQueue(cfg.orderQueue, cfg.exchange, binding);
  }
}

async function resetExchange(ch) {
  await ch.deleteExchange(cfg.exchange, { ifUnused: false });
  await assertTopology(ch);
}

async function waitForMessage(ch, queue, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msg = await ch.get(queue, { noAck: false });
    if (!msg) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (predicate(msg)) {
      ch.ack(msg);
      return msg;
    }
    ch.nack(msg, false, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function testAe(ch) {
  await assertTopology(ch);

  const temp = await ch.assertQueue('', {
    exclusive: true,
    autoDelete: true,
  });
  await ch.bindQueue(temp.queue, cfg.alternateExchange, '');

  const id = `codex-ae-${Date.now()}`;
  const body = Buffer.from(
    JSON.stringify({
      eventId: id,
      eventType: 'codex.unroutable.live_check',
      payload: { id },
    }),
  );
  ch.publish(cfg.exchange, `codex.unroutable.${Date.now()}`, body, {
    persistent: true,
    contentType: 'application/json',
    messageId: id,
    expiration: '60000',
  });
  await ch.waitForConfirms();

  const viaAe = await waitForMessage(
    ch,
    temp.queue,
    (msg) => msg.properties.messageId === id,
    5000,
  );
  if (!viaAe) throw new Error('unroutable message did not reach alternate exchange');

  const parked = await waitForMessage(
    ch,
    cfg.alternateQueue,
    (msg) => msg.properties.messageId === id,
    5000,
  );
  if (!parked) throw new Error('unroutable message did not reach parking queue');

  console.log(`AE_OK exchange=${cfg.exchange} parkingQueue=${cfg.alternateQueue}`);
}

async function testOrderRouting(ch) {
  await assertTopology(ch);
  const before = await ch.checkQueue(cfg.orderQueue);
  const id = `codex-product-${Date.now()}`;
  const body = Buffer.from(
    JSON.stringify({
      eventId: id,
      eventType: 'product.stock.changed',
      aggregateType: 'product_branch_details',
      aggregateId: '999999:999999',
      occurredAt: new Date().toISOString(),
      payload: { branchId: 999999, productId: 999999, stock: 1 },
    }),
  );
  ch.publish(cfg.exchange, 'product.stock.changed', body, {
    persistent: true,
    contentType: 'application/json',
    messageId: id,
  });
  await ch.waitForConfirms();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const after = await ch.checkQueue(cfg.orderQueue);
  console.log(
    `ORDER_ROUTE_OK before=${before.messageCount} after=${after.messageCount} consumers=${after.consumerCount}`,
  );
}

async function publishEnvelope(ch, routingKey, payload) {
  const id = `codex-${routingKey}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const body = Buffer.from(
    JSON.stringify({
      eventId: id,
      eventType: routingKey,
      aggregateType: 'product_branch_details',
      aggregateId: `${payload.branchId}:${payload.productId}`,
      occurredAt: new Date().toISOString(),
      payload,
    }),
  );
  ch.publish(cfg.exchange, routingKey, body, {
    persistent: true,
    contentType: 'application/json',
    messageId: id,
  });
  await ch.waitForConfirms();
  return id;
}

async function waitFor(fn, label, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function testProductInvalidation(ch) {
  await assertTopology(ch);
  const redis = new Redis({
    host: cfg.redisHost,
    port: cfg.redisPort,
    password: cfg.redisPassword,
    maxRetriesPerRequest: 1,
  });
  const branchId = 989898;
  const productId = 979797;
  const metaKey = `core:product:meta:${branchId}:${productId}`;
  const stockKey = `core:product:stock:${branchId}:${productId}`;

  try {
    await redis.set(metaKey, JSON.stringify({ productId, name: 'codex', price: 1 }));
    await redis.set(stockKey, '10');
    await publishEnvelope(ch, 'product.stock.changed', { branchId, productId });
    await waitFor(
      async () => (await redis.exists(stockKey)) === 0,
      'stock cache deletion',
    );
    if ((await redis.exists(metaKey)) !== 1) {
      throw new Error('stock event incorrectly deleted meta cache');
    }

    await redis.set(stockKey, '10');
    await publishEnvelope(ch, 'product.price.changed', { branchId, productId });
    await waitFor(
      async () => (await redis.exists(metaKey)) === 0,
      'price meta cache deletion',
    );
    if ((await redis.exists(stockKey)) !== 1) {
      throw new Error('price event incorrectly deleted stock cache');
    }

    await redis.set(metaKey, JSON.stringify({ productId, name: 'codex', price: 2 }));
    await publishEnvelope(ch, 'product.meta.changed', { branchId, productId });
    await waitFor(
      async () => (await redis.exists(metaKey)) === 0,
      'meta cache deletion',
    );
    if ((await redis.exists(stockKey)) !== 1) {
      throw new Error('meta event incorrectly deleted stock cache');
    }

    await redis.del(metaKey, stockKey);
    console.log('PRODUCT_INVALIDATION_OK stock price meta');
  } finally {
    await redis.del(metaKey, stockKey).catch(() => {});
    await redis.quit().catch(() => {});
  }
}

async function main() {
  const mode = process.argv[2] || 'test-ae';
  const { conn, ch } = await connect();
  try {
    if (mode === 'reset-exchange') await resetExchange(ch);
    else if (mode === 'test-ae') await testAe(ch);
    else if (mode === 'test-order-route') await testOrderRouting(ch);
    else if (mode === 'test-product-invalidation') await testProductInvalidation(ch);
    else if (mode === 'assert') await assertTopology(ch);
    else throw new Error(`unknown mode: ${mode}`);
  } finally {
    await ch.close().catch(() => {});
    await conn.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
