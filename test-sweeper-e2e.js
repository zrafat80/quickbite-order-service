/**
 * E2E Test: Assignment Sweeper Worker
 *
 * Tests that the sweeper detects a stale agent (last_seen_at > 5 min)
 * and automatically reassigns the order.
 *
 * Flow:
 *   1. Agent goes online → order placed → lifecycle to ready → auto-assigned
 *   2. Fake the agent's Redis last_seen_at to 10 minutes ago
 *   3. Wait for the sweeper cron (runs every 60s) to fire
 *   4. Verify the order is no longer assigned to the original agent
 */
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { Client } = require('pg');

const ACCESS_SECRET = 'veryBigSecret';
const ORDER_SVC = 'http://127.0.0.1:4000/api';
const PG_URI = 'postgresql://postgres:zeyiad123123@localhost:5432/order_service_eg';

function signToken(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '1h' });
}

const customerToken = signToken({
  userId: 5, email: 'customer@example.com', role: 'customer',
});
const agentToken = signToken({
  userId: 48, email: 'agent@example.com', role: 'delivery_agent',
});
const staffToken = signToken({
  userId: 47, email: 'staff@example.com', role: 'restaurant_user',
  restaurantRole: 'branch_manager', restaurantId: 3, branchIds: [3],
});

let pass = 0, fail = 0;

async function request(url, method, token, body, headers = {}) {
  const reqHeaders = { 'Content-Type': 'application/json', 'X-Region': 'eg', ...headers };
  if (token) reqHeaders['Cookie'] = `access_token=${token}`;
  const res = await fetch(`${ORDER_SVC}${url}`, {
    method, headers: reqHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, text }; }
}

function assert(name, condition, detail) {
  if (condition) { console.log(`  ✅ [PASS] ${name}${detail ? ' — ' + detail : ''}`); pass++; }
  else           { console.log(`  ❌ [FAIL] ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

async function run() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  E2E: Assignment Sweeper (Stale Agent Auto-Reassignment)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const redis = new Redis();
  const pg = new Client(PG_URI);
  await pg.connect();

  // ─── STEP 1: Agent online ─────────────────────────────────────────────────
  console.log('Step 1 — Agent goes online');
  const online = await request('/agents/presence/online', 'POST', agentToken, {
    lat: 30.0444, lng: 31.2357,
  });
  assert('Agent online', online.status === 201);

  // ─── STEP 2: Place + lifecycle → assigned ─────────────────────────────────
  console.log('\nStep 2 — Place order and drive to ASSIGNED');
  const create = await request('/orders', 'POST', customerToken, {
    branchId: 3, customerAddressId: 1, paymentMethod: 'cod',
    items: [{ productId: 1, quantity: 1, notes: '' }],
  }, { 'Idempotency-Key': `sweeper-e2e-${Date.now()}` });
  assert('Order created', create.status === 201);
  if (create.status !== 201) { await cleanup(redis, pg); return; }

  const publicId = create.data.data.id;
  console.log(`  orderId = ${publicId}`);

  for (const s of ['accepted', 'preparing', 'ready']) {
    await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: s });
  }
  await new Promise(r => setTimeout(r, 1500));

  // Verify assigned to agent 48
  const tasks = await request('/agents/tasks?status=assigned', 'GET', agentToken);
  const myTask = tasks.data?.data?.find(t => t.orderId === publicId);
  assert('Order assigned to agent 48', !!myTask);
  if (!myTask) { await cleanup(redis, pg); return; }

  // Get the DB order id for later checks
  const orderRow = await pg.query(
    'SELECT id, delivery_agent_id, status FROM orders WHERE public_id = $1', [publicId]
  );
  const orderId = orderRow.rows[0].id;
  const assignedAgentBefore = orderRow.rows[0].delivery_agent_id;
  console.log(`  DB order.id=${orderId}, delivery_agent_id=${assignedAgentBefore}, status=${orderRow.rows[0].status}`);
  assert('DB confirms agent 48 assigned', Number(assignedAgentBefore) === 48);

  // ─── STEP 3: Fake the agent's last_seen_at to 10 minutes ago ──────────
  console.log('\nStep 3 — Fake agent 48 last_seen_at to 10 minutes ago in Redis');
  const metaKey = `presence:meta:eg:48`;
  const tenMinAgo = Date.now() - (10 * 60 * 1000);
  await redis.hset(metaKey, 'last_seen_at', String(tenMinAgo));

  // Verify the fake
  const faked = await redis.hget(metaKey, 'last_seen_at');
  const ageMin = ((Date.now() - Number(faked)) / 60000).toFixed(1);
  console.log(`  last_seen_at now = ${faked} (${ageMin} min ago)`);
  assert('last_seen_at is > 5 min ago', Number(ageMin) > 5);

  // ─── STEP 4: Wait for sweeper ─────────────────────────────────────────────
  console.log('\nStep 4 — Waiting for sweeper to run (up to 75 seconds)...');
  console.log('  The sweeper runs every 60s. Polling DB every 5s...\n');

  let reassigned = false;
  const deadline = Date.now() + 75_000; // 75 seconds max wait

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));

    const check = await pg.query(
      'SELECT delivery_agent_id, status FROM orders WHERE public_id = $1', [publicId]
    );
    const row = check.rows[0];
    const elapsed = Math.round((Date.now() - (deadline - 75_000)) / 1000);
    process.stdout.write(`  [${elapsed}s] status=${row.status}, agent=${row.delivery_agent_id}\n`);

    // The sweeper calls handleAgentReject which clears assignment → READY,
    // then re-runs tryAssign. Two outcomes:
    //   a) Another agent picks it up (unlikely — only agent 48 is online)
    //   b) No candidates → order stays READY with no agent
    //   c) Agent 48 got evicted from Redis → tryAssign finds nobody → READY
    if (row.status !== 'assigned' || Number(row.delivery_agent_id) !== 48) {
      reassigned = true;
      console.log(`\n  🎉 Sweeper acted! status=${row.status}, agent=${row.delivery_agent_id}`);
      break;
    }
  }

  assert('Sweeper reassigned the stale order', reassigned);

  // ─── STEP 5: Verify final state ──────────────────────────────────────────
  console.log('\nStep 5 — Verify final state');
  const finalRow = await pg.query(
    'SELECT delivery_agent_id, status, assignment_attempts FROM orders WHERE public_id = $1',
    [publicId]
  );
  const final = finalRow.rows[0];
  console.log(`  status=${final.status}, agent=${final.delivery_agent_id}, attempts=${final.assignment_attempts}`);

  // The order should either be:
  //   - READY with no agent (if no other agents available)
  //   - ASSIGNED to a different agent
  //   - Or still ASSIGNED to 48 but with incremented attempts (if re-assigned back)
  assert(
    'Order is no longer stale-assigned to agent 48',
    final.status === 'ready' || Number(final.delivery_agent_id) !== 48,
    `status=${final.status}, agent=${final.delivery_agent_id}`
  );

  await cleanup(redis, pg);
}

async function cleanup(redis, pg) {
  console.log('\n--- Cleanup ---');
  // Put agent back online with fresh heartbeat
  await request('/agents/presence/online', 'POST', agentToken, {
    lat: 30.0444, lng: 31.2357,
  });
  await request('/agents/presence/offline', 'POST', agentToken);

  redis.disconnect();
  await pg.end();

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  Summary: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);
  if (fail > 0) process.exit(1);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
