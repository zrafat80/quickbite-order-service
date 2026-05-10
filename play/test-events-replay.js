/**
 * Dedupe (replay) test. Publishes the SAME envelope twice directly to RabbitMQ
 * (bypassing the outbox so we can re-publish without the unique event_id PK).
 *
 * Asserts:
 *   1. First delivery: handler runs (cache key gets deleted).
 *   2. Second delivery (same eventId): handler is skipped via Redis SETNX dedupe
 *      — proven by re-seeding the cache after delivery #1 and confirming the
 *      seeded value survives delivery #2.
 *
 * Run from order-service/:
 *   node play/test-events-replay.js
 */

const amqp = require('amqplib');
const Redis = require('ioredis');
const { randomUUID } = require('node:crypto');

const RABBIT_URL = 'amqp://guest:guest@localhost:5672';
const EXCHANGE = 'core.events';
const REDIS = { host: 'localhost', port: 6379 };

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollDeleted(redis, key, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await redis.get(key)) === null) return true;
    await sleep(100);
  }
  return false;
}

async function pollPresent(redis, key, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await redis.get(key)) !== null) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  const redis = new Redis(REDIS);
  const conn = await amqp.connect(RABBIT_URL);
  const ch = await conn.createConfirmChannel();
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });

  const branchId = 88;
  const cacheKey = `core:branch:${branchId}`;
  const eventId = randomUUID();
  const dedupeKey = `core-events:dedupe:${eventId}`;
  const envelope = {
    eventId,
    eventType: 'branch.updated',
    occurredAt: new Date().toISOString(),
    aggregateType: 'branch',
    aggregateId: String(branchId),
    payload: { branchId },
  };
  const body = Buffer.from(JSON.stringify(envelope), 'utf8');

  // Clean slate.
  await redis.del(cacheKey, dedupeKey);

  console.log('--- delivery #1 (fresh) ---');
  await redis.set(cacheKey, 'v1');
  console.log(`  seeded ${cacheKey} = v1`);
  await new Promise((resolve, reject) => {
    ch.publish(EXCHANGE, 'branch.updated', body, { persistent: true, contentType: 'application/json' }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
  console.log(`  published eventId=${eventId}`);

  if (!(await pollDeleted(redis, cacheKey))) {
    throw new Error(`first delivery: ${cacheKey} was not deleted within 5s`);
  }
  console.log(`  ✅ handler ran: ${cacheKey} deleted`);
  if (!(await pollPresent(redis, dedupeKey))) {
    throw new Error('first delivery: dedupe key not set');
  }
  console.log(`  ✅ dedupe key set: ${dedupeKey}`);

  console.log('\n--- delivery #2 (replay, same eventId) ---');
  await redis.set(cacheKey, 'v2-after-first');
  console.log(`  re-seeded ${cacheKey} = v2-after-first`);
  await new Promise((resolve, reject) => {
    ch.publish(EXCHANGE, 'branch.updated', body, { persistent: true, contentType: 'application/json' }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
  console.log(`  re-published eventId=${eventId}`);

  // Give the consumer up to 2s to NOT delete it.
  await sleep(2000);
  const v = await redis.get(cacheKey);
  if (v !== 'v2-after-first') {
    throw new Error(
      `replay was not deduped: ${cacheKey} = ${JSON.stringify(v)} (expected v2-after-first)`,
    );
  }
  console.log(`  ✅ handler skipped: ${cacheKey} still = ${v} (replay deduped)`);

  // Cleanup
  await redis.del(cacheKey, dedupeKey);
  await ch.close();
  await conn.close();
  await redis.quit();
  console.log('\n✅ replay/dedupe test passed');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
