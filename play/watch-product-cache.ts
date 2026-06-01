/**
 * Polls the product cache 50× over ~5s. Place a COD order *before* (or
 * during) this script, and you'll see the keys appear and then vanish
 * within ~100-200ms — that's the product.stock.changed event landing.
 *
 * Usage:  npx ts-node play/watch-product-cache.ts <branchId> <productId> [<productId> ...]
 */
import Redis from 'ioredis';
import { config as loadEnv } from 'dotenv';
loadEnv();

async function main() {
  const [, , branchId, ...productIds] = process.argv;
  if (!branchId || productIds.length === 0) {
    console.error('Usage: ts-node play/watch-product-cache.ts <branchId> <productId> [<productId> ...]');
    process.exit(1);
  }
  const client = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  });
  const keys = productIds.map((pid) => `core:product:${branchId}:${pid}`);
  const start = Date.now();
  let seen = false;
  for (let i = 0; i < 100; i++) {
    const present: string[] = [];
    for (const k of keys) {
      const v = await client.exists(k);
      if (v) present.push(k);
    }
    if (present.length > 0) seen = true;
    const t = Date.now() - start;
    console.log(`+${t}ms  present=${present.length}/${keys.length}  ${present.join(',') || '(none)'}`);
    if (i > 10 && present.length === 0 && seen) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await client.quit();
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
