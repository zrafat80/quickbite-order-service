/**
 * Verifies the refactored GET /api/payments/:id — now routed through
 * OrderService.findOwnershipById instead of an inline DB query.
 *
 * Uses the charge created by the ngrok webhook test (id=3, order public_id
 * b678d94d-…). Hits the endpoint with: (a) a system_admin token, (b) the
 * customer who owns the order (should be forbidden — GET is admin/restaurant
 * only), (c) a restaurant_user with restaurantId=1 (owner of branch_id=1).
 */
import { config as loadEnv } from 'dotenv';
import * as jwt from 'jsonwebtoken';
loadEnv();

const BASE = 'http://localhost:4000';
const REGION = 'eg';

function tok(payload: object): string {
  return jwt.sign(payload, process.env.ACCESS_SECRET!, { expiresIn: '1h' });
}

async function get(id: number, cookie: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/payments/${id}`, {
    headers: {
      'X-Region': REGION,
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
  });
  const txt = await res.text();
  let body: any;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: res.status, body };
}

async function main() {
  const chargeId = 3;
  const admin = `access_token=${tok({ userId: 1, role: 'system_admin' })}`;
  const customer = `access_token=${tok({ userId: 5, role: 'customer' })}`;
  const restaurant = `access_token=${tok({
    userId: 7,
    role: 'restaurant_user',
    restaurantId: 1,
    restaurantRole: 'owner',
    branchIds: [1],
  })}`;
  const wrongRestaurant = `access_token=${tok({
    userId: 8,
    role: 'restaurant_user',
    restaurantId: 999,
    restaurantRole: 'owner',
    branchIds: [],
  })}`;

  for (const [label, c] of [
    ['admin', admin],
    ['customer (own)', customer],
    ['restaurant_user (owner)', restaurant],
    ['restaurant_user (other)', wrongRestaurant],
  ] as const) {
    const r = await get(chargeId, c);
    console.log(
      `${label.padEnd(28)} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
