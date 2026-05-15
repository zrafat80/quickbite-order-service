/**
 * E2E Test: Full Order + Agent lifecycle — every case.
 *
 * Drives the live order-service (port 4000) over HTTP, exactly as the existing
 * test-delivery-e2e.js / test-delivery-failures-e2e.js / test-sweeper-e2e.js do,
 * but as one consolidated run covering:
 *
 *   1. Restaurant REJECT          placed -> rejected
 *   2. Happy path                 placed -> accepted -> preparing -> ready
 *                                 -> assigned -> agent accept -> pickup
 *                                 -> delivered -> earnings recorded
 *   3. Agent REJECT -> reassign   assigned agent rejects, order moves to the
 *                                 other online agent
 *   4. Stale agent -> sweeper     assigned agent's heartbeat goes >5 min old,
 *                                 the sweeper reassigns the order
 *   5. Failure cases              invalid restaurant transition, unassigned
 *                                 agent pickup, deliver-before-pickup,
 *                                 go-offline-while-picked
 *
 * Pre-conditions (same as the other e2e files):
 *   - order-service running on 127.0.0.1:4000
 *   - core-service running with branch 3 / product 1 / customer address 1
 *   - Postgres + Redis up
 */
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { Client } = require('pg');

const ACCESS_SECRET = 'veryBigSecret';
const ORDER_SVC = 'http://127.0.0.1:4000/api';
const CORE_SVC = 'http://localhost:3000';
const CORE_INTERNAL_API_KEY = 'changeme';
const PG_URI = 'postgresql://postgres:zeyiad123123@localhost:5432/order_service_eg';

const sign = (p) => jwt.sign(p, ACCESS_SECRET, { expiresIn: '1h' });

const customerToken = sign({ userId: 5, email: 'customer@example.com', role: 'customer' });
const agentAToken = sign({ userId: 48, email: 'agentA@example.com', role: 'delivery_agent' });
const agentBToken = sign({ userId: 49, email: 'agentB@example.com', role: 'delivery_agent' });
const staffToken = sign({
  userId: 47, email: 'staff@example.com', role: 'restaurant_user',
  restaurantRole: 'branch_manager', restaurantId: 3, branchIds: [3],
});

const AGENTS = { 48: agentAToken, 49: agentBToken };

// Agents must go online within the assignment radius (5 km) of branch 3.
// Resolved from core-service at startup so the test survives a branch move.
let AGENT_LOC = { lat: 29.9538, lng: 31.2634 };

async function resolveBranchLocation() {
  try {
    const res = await fetch(`${CORE_SVC}/api/internal/branches/3`, {
      headers: { 'x-api-key': CORE_INTERNAL_API_KEY },
    });
    const json = await res.json();
    const b = json.data;
    if (b && typeof b.lat === 'number' && typeof b.lng === 'number') {
      AGENT_LOC = { lat: b.lat, lng: b.lng };
      console.log(`  branch 3 @ (${b.lat}, ${b.lng}) — agents will go online there`);
    }
  } catch (e) {
    console.log(`  could not resolve branch 3 location (${e.message}) — using default`);
  }
}

let pass = 0, fail = 0;

async function request(url, method, token, body, headers = {}) {
  const reqHeaders = { 'Content-Type': 'application/json', 'X-Region': 'eg', ...headers };
  if (token) reqHeaders['Cookie'] = `access_token=${token}`;
  const res = await fetch(`${ORDER_SVC}${url}`, {
    method, headers: reqHeaders, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, text }; }
}

function assert(name, condition, detail) {
  if (condition) { console.log(`  ✅ [PASS] ${name}${detail ? ' — ' + detail : ''}`); pass++; }
  else { console.log(`  ❌ [FAIL] ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n─── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);

// ── shared helpers ──────────────────────────────────────────────────────────

async function placeOrder(qty = 1) {
  const res = await request('/orders', 'POST', customerToken, {
    branchId: 3, customerAddressId: 1, paymentMethod: 'cod',
    items: [{ productId: 1, quantity: qty, notes: '' }],
  }, { 'Idempotency-Key': `order-agent-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  return res;
}

async function driveToReady(publicId) {
  for (const s of ['accepted', 'preparing', 'ready']) {
    await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: s });
  }
}

/** Poll the DB until the order has a delivery agent (auto-assignment is async). */
async function waitForAssignment(pg, publicId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pg.query(
      'SELECT status, delivery_agent_id FROM orders WHERE public_id = $1', [publicId],
    );
    const row = r.rows[0];
    if (row && row.status === 'assigned' && row.delivery_agent_id) return Number(row.delivery_agent_id);
    await sleep(500);
  }
  return null;
}

async function setAgentOnline(agentId) {
  return request('/agents/presence/online', 'POST', AGENTS[agentId], AGENT_LOC);
}
async function setAgentOffline(agentId) {
  return request('/agents/presence/offline', 'POST', AGENTS[agentId]);
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function scenarioRestaurantReject() {
  section('Scenario 1 — Restaurant rejects a placed order');
  const create = await placeOrder();
  assert('Order placed (201)', create.status === 201, `status=${create.status}`);
  if (create.status !== 201) return;
  const publicId = create.data.data.id;

  const reject = await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: 'rejected' });
  assert('Restaurant reject (200)', reject.status === 200, `status=${reject.status}`);

  const after = await request(`/orders/${publicId}`, 'GET', customerToken);
  assert('Order status is rejected', after.data?.data?.status === 'rejected',
    `status=${after.data?.data?.status}`);
}

async function scenarioHappyPath(pg) {
  section('Scenario 2 — Full happy path (accept → deliver → earnings)');
  await setAgentOffline(48);
  const online = await setAgentOnline(48);
  assert('Agent 48 online (201)', online.status === 201, `status=${online.status}`);

  const create = await placeOrder(2);
  assert('Order placed (201)', create.status === 201, `status=${create.status}`);
  if (create.status !== 201) return;
  const publicId = create.data.data.id;

  const accepted = await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: 'accepted' });
  assert('placed → accepted (200)', accepted.status === 200, `status=${accepted.status}`);
  const preparing = await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: 'preparing' });
  assert('accepted → preparing (200)', preparing.status === 200, `status=${preparing.status}`);
  const ready = await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: 'ready' });
  assert('preparing → ready (200)', ready.status === 200, `status=${ready.status}`);

  const agent = await waitForAssignment(pg, publicId);
  assert('Auto-assigned to agent 48', agent === 48, `agent=${agent}`);

  const taskList = await request('/agents/tasks?status=assigned', 'GET', agentAToken);
  const task = taskList.data?.data?.find((t) => t.orderId === publicId);
  assert('Order appears in agent 48 task list', !!task);

  // agent ACCEPT — acknowledgment only, order stays assigned
  const ack = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentAToken, { status: 'accept' });
  assert('Agent accept ack (200)', ack.status === 200, `status=${ack.status}`);

  const pickup = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentAToken, { status: 'pickup' });
  assert('assigned → picked (200)', pickup.status === 200, `status=${pickup.status}`);

  const deliver = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentAToken, { status: 'deliver' });
  assert('picked → delivered (200)', deliver.status === 200, `status=${deliver.status}`);

  const finalRow = await pg.query('SELECT status FROM orders WHERE public_id = $1', [publicId]);
  assert('Order status is delivered', finalRow.rows[0]?.status === 'delivered',
    `status=${finalRow.rows[0]?.status}`);

  const earningRow = await pg.query(
    `SELECT amount FROM agent_earnings
       WHERE order_id = (SELECT id FROM orders WHERE public_id = $1)`, [publicId]);
  assert('Agent earning row recorded', earningRow.rows.length === 1 && Number(earningRow.rows[0].amount) > 0,
    `amount=${earningRow.rows[0]?.amount}`);

  const earnApi = await request('/agents/earnings', 'GET', agentAToken);
  assert('GET /agents/earnings (200)', earnApi.status === 200, `status=${earnApi.status}`);

  await setAgentOffline(48);
}

async function scenarioAgentReject(pg) {
  section('Scenario 3 — Agent rejects → order reassigned to the other agent');
  await setAgentOffline(48);
  await setAgentOffline(49);
  assert('Agent 48 online', (await setAgentOnline(48)).status === 201);
  assert('Agent 49 online', (await setAgentOnline(49)).status === 201);

  const create = await placeOrder();
  if (create.status !== 201) { assert('Order placed', false, `status=${create.status}`); return; }
  const publicId = create.data.data.id;
  await driveToReady(publicId);

  const firstAgent = await waitForAssignment(pg, publicId);
  assert('Order auto-assigned to an agent', firstAgent === 48 || firstAgent === 49, `agent=${firstAgent}`);
  if (!firstAgent) return;
  const otherAgent = firstAgent === 48 ? 49 : 48;

  const reject = await request(`/orders/${publicId}/delivery-status`, 'PATCH', AGENTS[firstAgent], { status: 'reject' });
  assert(`Agent ${firstAgent} reject (200)`, reject.status === 200, `status=${reject.status}`);

  // handleAgentReject re-runs assignment synchronously inside the request.
  await sleep(800);
  const row = await pg.query('SELECT status, delivery_agent_id FROM orders WHERE public_id = $1', [publicId]);
  const newAgent = Number(row.rows[0]?.delivery_agent_id);
  assert(`Order no longer assigned to rejecting agent ${firstAgent}`,
    newAgent !== firstAgent, `now agent=${row.rows[0]?.delivery_agent_id} status=${row.rows[0]?.status}`);
  assert(`Order reassigned to agent ${otherAgent}`,
    newAgent === otherAgent, `agent=${row.rows[0]?.delivery_agent_id}`);

  // Finish the order so both agents free up cleanly.
  if (newAgent === otherAgent) {
    await request(`/orders/${publicId}/delivery-status`, 'PATCH', AGENTS[otherAgent], { status: 'pickup' });
    await request(`/orders/${publicId}/delivery-status`, 'PATCH', AGENTS[otherAgent], { status: 'deliver' });
  }
  await setAgentOffline(48);
  await setAgentOffline(49);
}

async function scenarioStaleSweeper(pg, redis) {
  section('Scenario 4 — Stale agent heartbeat → sweeper reassigns');
  await setAgentOffline(48);
  await setAgentOffline(49);
  assert('Agent 48 online', (await setAgentOnline(48)).status === 201);
  assert('Agent 49 online', (await setAgentOnline(49)).status === 201);

  const create = await placeOrder();
  if (create.status !== 201) { assert('Order placed', false, `status=${create.status}`); return; }
  const publicId = create.data.data.id;
  await driveToReady(publicId);

  const staleAgent = await waitForAssignment(pg, publicId);
  assert('Order auto-assigned to an agent', staleAgent === 48 || staleAgent === 49, `agent=${staleAgent}`);
  if (!staleAgent) return;
  const freshAgent = staleAgent === 48 ? 49 : 48;

  // Backdate the assigned agent's heartbeat to 10 minutes ago (sweeper cutoff = 5 min).
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  await redis.hset(`presence:meta:eg:${staleAgent}`, 'last_seen_at', String(tenMinAgo));
  console.log(`  faked agent ${staleAgent} last_seen_at to 10 min ago; sweeper runs every 10s...`);

  let reassigned = false, finalAgent = null, finalStatus = null;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await pg.query('SELECT status, delivery_agent_id FROM orders WHERE public_id = $1', [publicId]);
    finalAgent = Number(r.rows[0]?.delivery_agent_id);
    finalStatus = r.rows[0]?.status;
    if (finalStatus !== 'assigned' || finalAgent !== staleAgent) { reassigned = true; break; }
  }
  assert('Sweeper acted on the stale assignment', reassigned,
    `status=${finalStatus}, agent=${finalAgent}`);
  assert('Order moved off the stale agent',
    finalAgent !== staleAgent, `agent=${finalAgent}`);

  // cleanup — drive whatever survived to a terminal state, free agents.
  if (finalStatus === 'assigned' && finalAgent === freshAgent) {
    await request(`/orders/${publicId}/delivery-status`, 'PATCH', AGENTS[freshAgent], { status: 'pickup' });
    await request(`/orders/${publicId}/delivery-status`, 'PATCH', AGENTS[freshAgent], { status: 'deliver' });
  }
  await setAgentOnline(48); await setAgentOffline(48);
  await setAgentOnline(49); await setAgentOffline(49);
}

async function scenarioFailures(pg) {
  section('Scenario 5 — Failure / guard cases');

  // 5a. invalid restaurant transition: placed → ready (skips accepted/preparing)
  const c1 = await placeOrder();
  if (c1.status === 201) {
    const bad = await request(`/orders/${c1.data.data.id}/status`, 'PATCH', staffToken, { status: 'ready' });
    assert('placed → ready rejected (409)', bad.status === 409, `status=${bad.status}`);
  } else {
    assert('placed → ready rejected (409)', false, 'order create failed');
  }

  // Build an order assigned to agent 48 for the remaining guard checks.
  await setAgentOffline(48);
  await setAgentOffline(49);
  await setAgentOnline(48);
  const c2 = await placeOrder();
  if (c2.status !== 201) {
    assert('setup order for guards', false, `status=${c2.status}`);
    await setAgentOffline(48);
    return;
  }
  const publicId = c2.data.data.id;
  await driveToReady(publicId);
  const assignedTo = await waitForAssignment(pg, publicId);
  assert('Guard-setup order assigned to agent 48', assignedTo === 48, `agent=${assignedTo}`);

  // 5b. unassigned agent (49) tries to pick up agent 48's order
  const foreignPickup = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentBToken, { status: 'pickup' });
  assert('Unassigned agent pickup blocked (403/404)',
    foreignPickup.status === 403 || foreignPickup.status === 404, `status=${foreignPickup.status}`);

  // 5c. deliver before pickup → 409 conflict
  const earlyDeliver = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentAToken, { status: 'deliver' });
  assert('Deliver before pickup blocked (409)', earlyDeliver.status === 409, `status=${earlyDeliver.status}`);

  // 5d. agent cannot go offline while holding a picked order
  await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentAToken, { status: 'pickup' });
  const offlineBlocked = await request('/agents/presence/offline', 'POST', agentAToken);
  assert('Go-offline while picked blocked (409)', offlineBlocked.status === 409, `status=${offlineBlocked.status}`);

  // cleanup — complete delivery, then offline
  await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentAToken, { status: 'deliver' });
  await setAgentOffline(48);
}

// ── runner ──────────────────────────────────────────────────────────────────

async function run() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  E2E: Order + Agent — full lifecycle, all cases');
  console.log('═══════════════════════════════════════════════════════════════');

  const redis = new Redis();
  const pg = new Client(PG_URI);
  await pg.connect();

  await resolveBranchLocation();

  // Best-effort reset — ignore 409 (agent may be mid-delivery from a prior run).
  await setAgentOffline(48).catch(() => {});
  await setAgentOffline(49).catch(() => {});

  try {
    await scenarioRestaurantReject();
    await scenarioHappyPath(pg);
    await scenarioAgentReject(pg);
    await scenarioStaleSweeper(pg, redis);
    await scenarioFailures(pg);
  } catch (err) {
    console.error('\nFATAL:', err);
    fail++;
  } finally {
    await setAgentOffline(48).catch(() => {});
    await setAgentOffline(49).catch(() => {});
    redis.disconnect();
    await pg.end();
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Summary: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

run();
