const jwt = require('jsonwebtoken');

const ACCESS_SECRET = 'veryBigSecret';
const ORDER_SVC = 'http://127.0.0.1:4000/api';

function signToken(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '1h' });
}

const customerToken = signToken({
  userId: 5,
  email: 'customer@example.com',
  role: 'customer'
});

// Assigned Agent
const agentToken = signToken({
  userId: 48,
  email: 'agent@example.com',
  role: 'delivery_agent'
});

// Unassigned Agent
const agent2Token = signToken({
  userId: 49,
  email: 'agent2@example.com',
  role: 'delivery_agent'
});

const staffToken = signToken({
  userId: 47,
  email: 'staff@example.com',
  role: 'restaurant_user',
  restaurantRole: 'branch_manager',
  restaurantId: 3,
  branchIds: [3]
});

async function request(url, method, token, body, headers = {}) {
  const reqHeaders = {
    'Content-Type': 'application/json',
    'X-Region': 'eg',
    ...headers
  };
  if (token) {
    reqHeaders['Cookie'] = `access_token=${token}`;
  }
  
  const res = await fetch(`${ORDER_SVC}${url}`, {
    method,
    headers: reqHeaders,
    body: body ? JSON.stringify(body) : undefined
  });
  
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return { status: res.status, data: json };
  } catch(e) {
    return { status: res.status, text };
  }
}

async function run() {
  console.log('--- E2E TEST: Failing Scenarios ---');
  let passed = 0;
  let total = 0;

  function assertEqual(name, actual, expected) {
    total++;
    if (actual === expected) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name} | Expected: ${expected}, Got: ${actual}`);
    }
  }

  // Ensure agents are offline first
  await request('/agents/presence/offline', 'POST', agentToken);
  await request('/agents/presence/offline', 'POST', agent2Token);

  // 1. Agent 1 goes online
  console.log('\n--- Setup ---');
  const onlineRes = await request('/agents/presence/online', 'POST', agentToken, {
    lat: 30.0444, // Cairo
    lng: 31.2357
  });
  console.log('Agent 1 online:', onlineRes.status);

  // Create order
  const createRes = await request('/orders', 'POST', customerToken, {
    branchId: 3,
    customerAddressId: 1,
    paymentMethod: 'cod',
    items: [{ productId: 1, quantity: 1, notes: '' }]
  }, { 'Idempotency-Key': 'fail-e2e-' + Date.now() });
  
  const publicId = createRes.data.data.publicId || createRes.data.data.id;
  
  await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: 'accepted' });
  await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: 'preparing' });
  await request(`/orders/${publicId}/status`, 'PATCH', staffToken, { status: 'ready' });

  // Give assignment loop a moment to assign to Agent 1
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n--- Scenario 1: Unassigned agent tries to pick up ---');
  const unauthorizedPickRes = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agent2Token, {
    status: 'pickup'
  });
  // Expecting 403 Forbidden or 404 (if filtered by assigned agent) or 409
  assertEqual('Agent 2 cannot pick up Agent 1 order', unauthorizedPickRes.status >= 400 ? 403 : unauthorizedPickRes.status, 403);
  if (unauthorizedPickRes.status < 400) console.log(unauthorizedPickRes.data);

  console.log('\n--- Scenario 2: Invalid delivery state transition (Deliver before Pickup) ---');
  const invalidDeliverRes = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentToken, {
    status: 'deliver'
  });
  // Expecting 409 Conflict
  assertEqual('Agent 1 cannot deliver without pickup', invalidDeliverRes.status, 409);
  if (invalidDeliverRes.status !== 409) console.log(invalidDeliverRes.data);

  console.log('\n--- Scenario 3: Agent tries to go offline after picking up ---');
  // First pick up the order
  await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentToken, { status: 'pickup' });
  
  const offlineFailRes = await request('/agents/presence/offline', 'POST', agentToken);
  // Expecting 409 Conflict because the order is now picked
  assertEqual('Agent 1 cannot go offline while picked up', offlineFailRes.status, 409);
  if (offlineFailRes.status !== 409) console.log(offlineFailRes.data);

  // Cleanup: Properly complete the flow so the agent is freed
  console.log('\n--- Cleanup ---');
  await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentToken, { status: 'deliver' });
  await request('/agents/presence/offline', 'POST', agentToken);
  
  console.log(`\n--- Test Summary: ${passed}/${total} passed ---`);
}

run().catch(console.error);
