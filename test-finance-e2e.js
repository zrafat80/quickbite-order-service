/**
 * E2E Test: Full Finance Pipeline with Real Money Values
 *
 * Pre-condition: core-service branch 3 has:
 *   deliveryFee = 1500 (piasters = 15 EGP)
 *   commission  = 2000 (bps = 20% — platform's cut)
 *   product 1 price = 4500 (piasters = 45 EGP)
 *
 * Expected for qty=2:
 *   subtotal    = 4500 × 2 = 9000
 *   deliveryFee = 1500
 *   total       = 10500
 *   commission  = floor(1500 × 2000 / 10000) = 300 (platform takes 20%)
 *   agentEarning= 1500 − 300 = 1200 (agent keeps 80%)
 *   restaurantBalance += 9000 (subtotal, restaurant gets full food revenue)
 */
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

const ACCESS_SECRET = 'veryBigSecret';
const ORDER_SVC = 'http://127.0.0.1:4000/api';
const PG_URI = 'postgresql://postgres:zeyiad123123@localhost:5432/order_service_eg';

function signToken(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '1h' });
}

const customerToken = signToken({
  userId: 5,
  email: 'customer@example.com',
  role: 'customer',
});

const agentToken = signToken({
  userId: 48,
  email: 'agent@example.com',
  role: 'delivery_agent',
});

const staffToken = signToken({
  userId: 47,
  email: 'staff@example.com',
  role: 'restaurant_user',
  restaurantRole: 'branch_manager',
  restaurantId: 3,
  branchIds: [3],
});

const adminToken = signToken({
  userId: 1,
  email: 'admin@example.com',
  role: 'system_admin',
});

// ── helpers ─────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;

async function request(url, method, token, body, headers = {}) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    'X-Region': 'eg',
    ...headers,
  };
  if (token) reqHeaders['Cookie'] = `access_token=${token}`;
  const res = await fetch(`${ORDER_SVC}${url}`, {
    method,
    headers: reqHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

function assert(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}${detail ? ' — ' + detail : ''}`);
    pass++;
  } else {
    console.log(`  ❌ [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function run() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  E2E: Full Finance Pipeline (Real Money Values)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Record restaurant balance BEFORE ─────────────────────────────────────
  const pg = new Client(PG_URI);
  await pg.connect();

  const balBefore = await pg.query(
    "SELECT balance FROM restaurant_balances WHERE restaurant_id=3 AND currency='EGP'"
  );
  const balanceBefore = balBefore.rows.length > 0 ? Number(balBefore.rows[0].balance) : 0;
  console.log(`  📊 Restaurant balance BEFORE: ${balanceBefore} piasters\n`);

  // ─── STEP 1: Agent online ─────────────────────────────────────────────────
  console.log('Step 1 — Agent goes online');
  const online = await request('/agents/presence/online', 'POST', agentToken, {
    lat: 30.0444, lng: 31.2357,
  });
  assert('Agent online', online.status === 201);

  // ─── STEP 2: Place order (COD, qty=2) ─────────────────────────────────────
  console.log('\nStep 2 — Customer places COD order (qty=2 × product 1)');
  const create = await request('/orders', 'POST', customerToken, {
    branchId: 3,
    customerAddressId: 1,
    paymentMethod: 'cod',
    items: [{ productId: 1, quantity: 2, notes: '' }],
  }, { 'Idempotency-Key': `real-finance-${Date.now()}` });

  assert('Order created (201)', create.status === 201, `status=${create.status}`);
  if (create.status !== 201) {
    console.log('  body:', JSON.stringify(create.data));
    await pg.end();
    return summary();
  }

  const orderData = create.data.data;
  const publicId = orderData.id;
  const { subtotal, deliveryFee, serviceFee, total } = orderData.money;
  console.log(`  orderId     = ${publicId}`);
  console.log(`  subtotal    = ${subtotal} piasters (expect 9000)`);
  console.log(`  deliveryFee = ${deliveryFee} piasters (expect 1500)`);
  console.log(`  serviceFee  = ${serviceFee}`);
  console.log(`  total       = ${total} piasters (expect 10500)`);

  assert('Subtotal = 9000', subtotal === 9000, `got ${subtotal}`);
  assert('DeliveryFee = 1500', deliveryFee === 1500, `got ${deliveryFee}`);
  assert('Total = 10500', total === 10500, `got ${total}`);

  // ─── STEP 3: Lifecycle → ready ────────────────────────────────────────────
  console.log('\nStep 3 — Staff lifecycle (accepted → preparing → ready)');
  for (const s of ['accepted', 'preparing', 'ready']) {
    const r = await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: s });
    assert(`Status → ${s}`, r.status === 200);
  }

  await new Promise((r) => setTimeout(r, 1500));

  // ─── STEP 4: Verify assignment ────────────────────────────────────────────
  console.log('\nStep 4 — Verify agent assignment');
  const tasks = await request('/agents/tasks?status=assigned', 'GET', agentToken);
  const myTask = tasks.data?.data?.find((t) => t.orderId === publicId);
  assert('Agent is assigned', !!myTask);

  if (myTask) {
    console.log(`  task.deliveryFee = ${myTask.deliveryFee} (expect 1500)`);
    assert('Task deliveryFee = 1500', myTask.deliveryFee === 1500, `got ${myTask.deliveryFee}`);
  }

  // ─── STEP 5: Pickup → Deliver ─────────────────────────────────────────────
  console.log('\nStep 5 — Agent pickup + deliver');
  const pickup = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentToken, { status: 'pickup' });
  assert('Pickup OK', pickup.status === 200);

  const deliver = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentToken, { status: 'deliver' });
  assert('Deliver OK', deliver.status === 200);
  if (deliver.status !== 200) {
    console.log('  body:', JSON.stringify(deliver.data));
    await pg.end();
    return summary();
  }

  // ─── STEP 6: Verify commission in DB ──────────────────────────────────────
  console.log('\nStep 6 — Verify commission transaction in DB');
  const commRes = await pg.query(
    `SELECT amount, status, transaction_type FROM transactions
     WHERE transaction_type = 'commission'
       AND order_id = (SELECT id FROM orders WHERE public_id = $1 LIMIT 1)
     LIMIT 1`,
    [publicId],
  );
  const comm = commRes.rows[0];
  assert('Commission tx exists', !!comm);
  if (comm) {
    console.log(`  commission amount = ${comm.amount} piasters (expect 300 = 20% of 1500 deliveryFee)`);
    assert('Commission amount = 300', Number(comm.amount) === 300, `got ${comm.amount}`);
    assert('Commission status = succeeded', comm.status === 'succeeded');
  }

  // ─── STEP 7: Verify order.commission column ───────────────────────────────
  console.log('\nStep 7 — Verify order.commission column in DB');
  const orderRow = await pg.query(
    'SELECT commission, subtotal, delivery_fee, total FROM orders WHERE public_id = $1',
    [publicId],
  );
  const o = orderRow.rows[0];
  if (o) {
    console.log(`  order.commission   = ${o.commission} (expect 300)`);
    console.log(`  order.subtotal     = ${o.subtotal} (expect 9000)`);
    console.log(`  order.delivery_fee = ${o.delivery_fee} (expect 1500)`);
    assert('Order commission = 300', Number(o.commission) === 300, `got ${o.commission}`);
  }

  // ─── STEP 8: Verify restaurant balance increase ──────────────────────────
  console.log('\nStep 8 — Verify restaurant balance');
  const balAfterRes = await pg.query(
    "SELECT balance FROM restaurant_balances WHERE restaurant_id=3 AND currency='EGP'"
  );
  const balanceAfter = Number(balAfterRes.rows[0]?.balance || 0);
  const balanceIncrease = balanceAfter - balanceBefore;
  console.log(`  balance BEFORE = ${balanceBefore}`);
  console.log(`  balance AFTER  = ${balanceAfter}`);
  console.log(`  increase       = ${balanceIncrease} (expect 9000 = full subtotal)`);
  assert('Balance increased by subtotal (9000)', balanceIncrease === 9000, `got ${balanceIncrease}`);

  // ─── STEP 9: Verify agent earnings ────────────────────────────────────────
  console.log('\nStep 9 — Verify agent earnings');
  const earningRes = await pg.query(
    `SELECT amount FROM agent_earnings
     WHERE order_id = (SELECT id FROM orders WHERE public_id = $1 LIMIT 1)
     LIMIT 1`,
    [publicId],
  );
  const earning = earningRes.rows[0];
  assert('Agent earning exists', !!earning);
  if (earning) {
    console.log(`  agent earning = ${earning.amount} piasters (expect 1200 = deliveryFee − commission)`);
    assert('Agent earning = 1200', Number(earning.amount) === 1200, `got ${earning.amount}`);
  }

  // ─── STEP 10: GET /restaurants/3/balance API ──────────────────────────────
  console.log('\nStep 10 — GET /restaurants/3/balance (API)');
  const balApi = await request('/restaurants/3/balance?currency=EGP', 'GET', adminToken);
  assert('Balance API 200', balApi.status === 200, `status=${balApi.status}`);
  if (balApi.status === 200) {
    const b = balApi.data.data || balApi.data;
    console.log(`  API balance = ${b.balance} (expect ${balanceAfter})`);
    assert('API balance matches DB', b.balance === balanceAfter, `api=${b.balance} db=${balanceAfter}`);
  } else {
    console.log('  body:', JSON.stringify(balApi.data));
  }

  // ─── STEP 11: Record a payout ─────────────────────────────────────────────
  console.log('\nStep 11 — Record payout (withdraw 5000 piasters = 50 EGP)');
  if (balanceAfter >= 5000) {
    const payoutRes = await request('/restaurants/3/payouts', 'POST', adminToken, {
      amount: 5000,
      currency: 'EGP',
      method: 'bank_transfer',
      dst: 'EG38 0019 0005 0000 0000 2631 180',
    }, { 'Idempotency-Key': `payout-real-${Date.now()}` });

    assert('Payout accepted', payoutRes.status === 201 || payoutRes.status === 200, `status=${payoutRes.status}`);
    if (payoutRes.status >= 200 && payoutRes.status < 300) {
      const p = payoutRes.data.data || payoutRes.data;
      console.log(`  payout id=${p.id}, amount=${p.amount}, status=${p.status}`);
    } else {
      console.log('  body:', JSON.stringify(payoutRes.data));
    }

    // Verify balance decreased
    const balFinal = await request('/restaurants/3/balance?currency=EGP', 'GET', adminToken);
    const finalBal = (balFinal.data.data || balFinal.data).balance;
    console.log(`  balance after payout = ${finalBal} (expect ${balanceAfter - 5000})`);
    assert('Balance decreased by 5000', finalBal === balanceAfter - 5000, `got ${finalBal}`);
  } else {
    console.log(`  Skipping: balance ${balanceAfter} < 5000`);
  }

  // ─── STEP 12: Overdraft guard ─────────────────────────────────────────────
  console.log('\nStep 12 — Overdraft guard');
  const bigPayout = await request('/restaurants/3/payouts', 'POST', adminToken, {
    amount: 999999999,
    currency: 'EGP',
    method: 'bank_transfer',
    dst: 'EG0000000000',
  }, { 'Idempotency-Key': `overdraft-${Date.now()}` });
  assert('Overdraft rejected (409)', bigPayout.status === 409, `status=${bigPayout.status}`);

  // ─── STEP 13: GET /restaurants/3/payouts (list) ───────────────────────────
  console.log('\nStep 13 — List payouts');
  const payoutList = await request('/restaurants/3/payouts', 'GET', adminToken);
  assert('Payouts list 200', payoutList.status === 200, `status=${payoutList.status}`);
  if (payoutList.status === 200) {
    const items = payoutList.data.data || [];
    console.log(`  payout count = ${items.length}`);
    assert('At least 1 payout', items.length >= 1, `got ${items.length}`);
  }

  // ─── STEP 14: Agent earnings API ──────────────────────────────────────────
  console.log('\nStep 14 — Agent earnings API');
  const earnApi = await request('/agents/earnings', 'GET', agentToken);
  assert('Earnings API 200', earnApi.status === 200);
  if (earnApi.status === 200) {
    const d = earnApi.data.data;
    const thisEarning = d.items.find((i) => i.orderPublicId === publicId);
    if (thisEarning) {
      console.log(`  earning for this order = ${thisEarning.amount} (expect 1200)`);
      assert('Earning amount = 1200', thisEarning.amount === 1200, `got ${thisEarning.amount}`);
    }
    console.log(`  total earnings sum = ${d.totals.sum}, count = ${d.totals.count}`);
  }

  // ─── STEP 15: Agent goes offline ──────────────────────────────────────────
  console.log('\nStep 15 — Agent goes offline');
  const offline = await request('/agents/presence/offline', 'POST', agentToken);
  assert('Agent offline', offline.status === 201);

  await pg.end();
  summary();
}

function summary() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Summary: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
