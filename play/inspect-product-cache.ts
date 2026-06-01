/**
 * Connects to Redis with the same config the app uses, prints every cache key
 * relevant to branch / product / address lookups so we can see what's actually
 * there after creating an order.
 *
 * Usage:  npx ts-node play/inspect-product-cache.ts
 */
import Redis from 'ioredis';
import { config as loadEnv } from 'dotenv';
loadEnv();

async function main() {
  const client = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  });

  const patterns = [
    'core:product:*',
    'core:branch:*',
    'core:address:*',
    'core:restaurant:*',
    'core:rbac:*',
  ];

  console.log(`Connected: ${client.options.host}:${client.options.port} db=${client.options.db ?? 0}`);
  console.log('────────────────────────────────────────────────');

  for (const pattern of patterns) {
    const keys = await client.keys(pattern);
    console.log(`\n${pattern} → ${keys.length} key(s)`);
    for (const k of keys.slice(0, 20)) {
      const ttl = await client.ttl(k);
      const val = await client.get(k);
      const preview = val ? val.slice(0, 100) : '(null)';
      console.log(`  ${k}  [ttl=${ttl}s]  ${preview}${val && val.length > 100 ? '…' : ''}`);
    }
    if (keys.length > 20) console.log(`  … and ${keys.length - 20} more`);
  }

  // Also report total keyspace sizes per pattern.
  const dbsize = await client.dbsize();
  console.log(`\nTotal DB size: ${dbsize} keys`);

  await client.quit();
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
