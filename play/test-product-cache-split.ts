/// <reference path="../src/lib/types/express.d.ts" />
/**
 * Verifies the meta/stock split:
 *
 *   S1 product.stock.changed   → stock gone, meta intact
 *   S2 product.price.changed   → meta gone, stock intact
 *   S3 product.meta.changed    → meta gone, stock intact
 *
 * Bypasses RabbitMQ entirely by invoking the handler directly through
 * HandlerRegistryService (the same code path the consumer uses). That keeps
 * the test deterministic — no waiting for broker round-trips.
 *
 * Usage:  npx ts-node --files play/test-product-cache-split.ts
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { REDIS_CACHE_PROVIDER } from '../src/lib/cache/redis.module';
import { cacheKeys } from '../src/lib/cache/cache-keys';
import { HandlerRegistryService } from '../src/lib/core-events/handler-registry.service';
import type { ICacheProvider } from '../src/pkg/cache/cache.interface';

loadEnv();

const BRANCH_ID = 990_001;
const PRODUCT_ID = 990_002;

type Result = { name: string; pass: boolean; details: string };
const results: Result[] = [];
function record(name: string, pass: boolean, details = '') {
  results.push({ name, pass, details });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${details ? ' :: ' + details : ''}`);
}

async function primeBoth(cache: ICacheProvider): Promise<void> {
  await cache.set(
    cacheKeys.productMeta(BRANCH_ID, PRODUCT_ID),
    JSON.stringify({ productId: PRODUCT_ID, name: 'X', price: 100, imageUrl: null, isAvailable: true }),
    60,
  );
  await cache.set(
    cacheKeys.productStock(BRANCH_ID, PRODUCT_ID),
    '42',
    60,
  );
}

async function present(cache: ICacheProvider): Promise<{ meta: boolean; stock: boolean }> {
  const [m, s] = await Promise.all([
    cache.get(cacheKeys.productMeta(BRANCH_ID, PRODUCT_ID)),
    cache.get(cacheKeys.productStock(BRANCH_ID, PRODUCT_ID)),
  ]);
  return { meta: m !== null, stock: s !== null };
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const cache = app.get<ICacheProvider>(REDIS_CACHE_PROVIDER);
  const registry = app.get(HandlerRegistryService);

  const stockHandler = registry.get('product.stock.changed');
  const priceHandler = registry.get('product.price.changed');
  const metaHandler = registry.get('product.meta.changed');

  if (!stockHandler || !priceHandler || !metaHandler) {
    record('handler registration', false, `stock=${!!stockHandler} price=${!!priceHandler} meta=${!!metaHandler}`);
    await app.close();
    process.exit(1);
  }
  record('handler registration', true, 'all 3 product.* handlers registered');

  // ────── S1: stock.changed only nukes stock ──────────────────────────────
  await primeBoth(cache);
  await stockHandler({ branchId: BRANCH_ID, productId: PRODUCT_ID });
  let state = await present(cache);
  record(
    'S1 product.stock.changed → meta intact, stock gone',
    state.meta === true && state.stock === false,
    `meta=${state.meta} stock=${state.stock}`,
  );

  // ────── S2: price.changed only nukes meta ───────────────────────────────
  await primeBoth(cache);
  await priceHandler({ branchId: BRANCH_ID, productId: PRODUCT_ID });
  state = await present(cache);
  record(
    'S2 product.price.changed → stock intact, meta gone',
    state.meta === false && state.stock === true,
    `meta=${state.meta} stock=${state.stock}`,
  );

  // ────── S3: meta.changed nukes meta ─────────────────────────────────────
  await primeBoth(cache);
  await metaHandler({ branchId: BRANCH_ID, productId: PRODUCT_ID });
  state = await present(cache);
  record(
    'S3 product.meta.changed → stock intact, meta gone',
    state.meta === false && state.stock === true,
    `meta=${state.meta} stock=${state.stock}`,
  );

  // cleanup
  await cache.del(cacheKeys.productMeta(BRANCH_ID, PRODUCT_ID));
  await cache.del(cacheKeys.productStock(BRANCH_ID, PRODUCT_ID));
  await app.close();

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n──── SUMMARY ────\npassed: ${passed}/${results.length}`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
