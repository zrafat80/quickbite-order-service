/// <reference path="../src/lib/types/express.d.ts" />
/**
 * Verifies the double-entry leg expansion on `settleDelivered`.
 *
 * Boots a NestApplicationContext (no HTTP server), pre-seeds branch metadata
 * into Redis so BranchClient short-circuits, inserts a synthetic order in
 * `picked` status with a delivery_agent_id, then drives it through
 * `OrderService.updateStatusInternal(... DELIVERED ...)` which calls
 * `AssignmentService.settleDelivered`.
 *
 * Scenarios:
 *   S1  COD, serviceFee=0  → expects 3 leg rows (commission, agent_earning,
 *                            restaurant_credit); cod_collection flips PENDING→SUCCEEDED.
 *   S2  Online, serviceFee>0 → expects all 4 legs including service_fee.
 *
 * Invariant (the whole point):
 *     subtotal + agent_share + commission + serviceFee == order.total
 *
 * Usage:  npx ts-node play/test-settlement-legs.ts
 */
import 'reflect-metadata';
import knex from 'knex';
import { config as loadEnv } from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { OrderService } from '../src/app/order/order.service';
import { REDIS_CLIENT } from '../src/lib/cache/redis.module';
import { cacheKeys } from '../src/lib/cache/cache-keys';
import { OrderStatus } from '../src/app/order/enums';

loadEnv();

const REGION = 'eg';
const BRANCH_ID = 901_234;       // synthetic
const RESTAURANT_ID = 901_234;   // synthetic
const CUSTOMER_ID = 5;
const AGENT_ID = 901_001;        // synthetic
const COMMISSION_BPS = 2000;     // 20%
const DELIVERY_FEE = 1500;       // 1500 minor units
const SUBTOTAL = 4000;

type Result = { name: string; pass: boolean; details: string };
const results: Result[] = [];
function record(name: string, pass: boolean, details = '') {
  results.push({ name, pass, details });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${details ? ' :: ' + details : ''}`);
}

async function seedOrder(
  k: ReturnType<typeof knex>,
  opts: {
    paymentMethod: 'online' | 'cod';
    serviceFee: number;
    assignAgent: boolean;
  },
): Promise<{ id: number; publicId: string; createdAt: Date; total: number }> {
  const publicId = uuidv4();
  const createdAt = new Date();
  const total = SUBTOTAL + DELIVERY_FEE + opts.serviceFee;
  const [row] = await k('orders')
    .insert({
      region: REGION,
      public_id: publicId,
      country_code: 'eg',
      restaurant_id: RESTAURANT_ID,
      branch_id: BRANCH_ID,
      customer_id: CUSTOMER_ID,
      customer_address_id: 1,
      delivery_lat: 30.0444,
      delivery_lng: 31.2357,
      delivery_address_text_snapshot: '12 Test St, Cairo, EG',
      status: OrderStatus.PICKED,
      subtotal: SUBTOTAL,
      delivery_fee: DELIVERY_FEE,
      service_fee: opts.serviceFee,
      total,
      currency: 'EGP',
      payment_method: opts.paymentMethod,
      delivery_agent_id: opts.assignAgent ? AGENT_ID : null,
      created_at: createdAt,
      updated_at: createdAt,
      accepted_at: createdAt,
      ready_at: createdAt,
      assigned_at: createdAt,
      picked_at: createdAt,
    })
    .returning(['id', 'created_at']);

  // For COD we need a PENDING cod_collection row that settleDelivered will flip.
  if (opts.paymentMethod === 'cod') {
    await k('transactions').insert({
      region: REGION,
      order_id: row.id,
      order_created_at: row.created_at,
      transaction_type: 'cod_collection',
      method: 'cod',
      status: 'pending',
      amount: total,
      currency: 'EGP',
      idempotency_key: `cod_collection:${publicId}`,
    });
  }
  return { id: Number(row.id), publicId, createdAt: row.created_at, total };
}

async function primeBranchCache(redis: any): Promise<void> {
  const meta = {
    id: BRANCH_ID,
    restaurantId: RESTAURANT_ID,
    restaurantStatus: 'active',
    restaurantName: 'Test Joint',
    countryCode: 'EG',
    isActive: true,
    acceptOrders: true,
    deliveryFee: DELIVERY_FEE,
    commission: COMMISSION_BPS,
    currency: 'EGP',
    lat: 30.0444,
    lng: 31.2357,
    label: 'Test Branch',
    addressText: '1 Test St',
  };
  // BranchClient uses CacheModule (keyv backend) on get, but writes through to
  // the same keyspace. Set the key via the raw ioredis client so it lands
  // where BranchClient will find it.
  // keyv stores JSON-wrapped strings with TTL; @keyv/redis prefixes keys with
  // "keyv:" by default. To stay compatible, set BOTH variants.
  const payload = JSON.stringify(meta);
  const wrapped = JSON.stringify({ value: payload, expires: Date.now() + 3600_000 });
  const key = cacheKeys.branch(BRANCH_ID);
  await redis.set(key, payload, 'EX', 3600);
  await redis.set(`keyv:${key}`, wrapped, 'EX', 3600);
}

async function legsFor(
  k: ReturnType<typeof knex>,
  orderId: number,
): Promise<any[]> {
  return k('transactions')
    .select('transaction_type', 'amount', 'src_acc_id', 'dst_acc_id', 'status', 'method')
    .where('order_id', orderId)
    .orderBy('id', 'asc');
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const orderService = app.get(OrderService);
  const redis = app.get(REDIS_CLIENT);

  const k = knex({
    client: 'pg',
    connection: {
      host: process.env.DB_eg_HOST,
      port: Number(process.env.DB_eg_PORT),
      user: process.env.DB_eg_USERNAME,
      password: process.env.DB_eg_PASSWORD,
      database: process.env.DB_eg_NAME,
    },
  });

  await primeBranchCache(redis);

  // ────── S1: COD, serviceFee=0 ────────────────────────────────────────────
  try {
    const o = await seedOrder(k, {
      paymentMethod: 'cod',
      serviceFee: 0,
      assignAgent: true,
    });
    await orderService.updateStatusInternal(
      REGION,
      o.id,
      o.createdAt,
      OrderStatus.DELIVERED,
      'delivered_at',
    );

    const legs = await legsFor(k, o.id);
    const byType: Record<string, any> = {};
    for (const l of legs) byType[l.transaction_type] = l;

    const commission = Math.floor((DELIVERY_FEE * COMMISSION_BPS) / 10000);
    const agentShare = DELIVERY_FEE - commission;

    const ok =
      byType.cod_collection?.status === 'succeeded' &&
      byType.commission?.amount === commission &&
      byType.commission?.src_acc_id === String(RESTAURANT_ID) &&
      byType.agent_earning?.amount === agentShare &&
      byType.agent_earning?.dst_acc_id === String(AGENT_ID) &&
      byType.restaurant_credit?.amount === SUBTOTAL &&
      byType.restaurant_credit?.dst_acc_id === String(RESTAURANT_ID) &&
      !byType.service_fee; // skipped when 0

    const sum =
      (byType.commission?.amount ?? 0) +
      (byType.agent_earning?.amount ?? 0) +
      (byType.restaurant_credit?.amount ?? 0) +
      (byType.service_fee?.amount ?? 0);

    const sumOk = sum === o.total;

    record(
      'S1 COD serviceFee=0 → 3 legs + cod flip + invariant',
      ok && sumOk,
      `legs=${legs.map((l) => l.transaction_type).join(',')} sum=${sum} total=${o.total}`,
    );
  } catch (err) {
    record('S1 COD serviceFee=0', false, (err as Error).message);
  }

  // ────── S2: Online, serviceFee>0 ─────────────────────────────────────────
  try {
    const serviceFee = 500;
    const o = await seedOrder(k, {
      paymentMethod: 'online',
      serviceFee,
      assignAgent: true,
    });
    await orderService.updateStatusInternal(
      REGION,
      o.id,
      o.createdAt,
      OrderStatus.DELIVERED,
      'delivered_at',
    );

    const legs = await legsFor(k, o.id);
    const byType: Record<string, any> = {};
    for (const l of legs) byType[l.transaction_type] = l;

    const commission = Math.floor((DELIVERY_FEE * COMMISSION_BPS) / 10000);
    const agentShare = DELIVERY_FEE - commission;

    const ok =
      byType.commission?.amount === commission &&
      byType.agent_earning?.amount === agentShare &&
      byType.restaurant_credit?.amount === SUBTOTAL &&
      byType.service_fee?.amount === serviceFee &&
      byType.service_fee?.src_acc_id === null &&
      byType.service_fee?.dst_acc_id === null;

    const sum =
      (byType.commission?.amount ?? 0) +
      (byType.agent_earning?.amount ?? 0) +
      (byType.restaurant_credit?.amount ?? 0) +
      (byType.service_fee?.amount ?? 0);
    const sumOk = sum === o.total;

    record(
      'S2 Online serviceFee>0 → 4 legs + invariant',
      ok && sumOk,
      `legs=${legs.map((l) => l.transaction_type).join(',')} sum=${sum} total=${o.total} svc=${byType.service_fee?.amount}`,
    );
  } catch (err) {
    record('S2 Online serviceFee>0', false, (err as Error).message);
  }

  await k.destroy();
  await app.close();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n──── SUMMARY ────`);
  console.log(`passed: ${passed}/${results.length}`);
  if (failed > 0) {
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  - ${r.name} :: ${r.details}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
