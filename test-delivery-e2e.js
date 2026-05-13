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

const agentToken = signToken({
  userId: 48,
  email: 'agent@example.com',
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
  console.log('--- E2E TEST: Agent Delivery Flow ---');
  
  // 1. Agent goes online
  console.log('1. Agent going online...');
  const onlineRes = await request('/agents/presence/online', 'POST', agentToken, {
    lat: 30.0444, // Cairo
    lng: 31.2357
  });
  console.log('Online result:', onlineRes.status, onlineRes.data);
  if (onlineRes.status !== 201) return;

  // 2. Create order
  console.log('\n2. Customer places order...');
  const createRes = await request('/orders', 'POST', customerToken, {
    branchId: 3,
    customerAddressId: 1,
    paymentMethod: 'cod',
    items: [{ productId: 1, quantity: 1, notes: '' }]
  }, { 'Idempotency-Key': 'test-e2e-' + Date.now() });
  
  console.log('Create order result:', createRes.status, createRes.data);
  if (createRes.status !== 201) return;
  const publicId = createRes.data.data.publicId || createRes.data.data.id;

  // 3. Staff accepts order
  console.log('\n3. Staff accepts order (accepted)...');
  const acceptRes1 = await request(`/orders/${publicId}/status`, 'PATCH', staffToken, {
    status: 'accepted'
  });
  console.log('Accept result:', acceptRes1.status, acceptRes1.data);

  console.log('\n3b. Staff prepares order...');
  const acceptRes2 = await request(`/orders/${publicId}/status`, 'PATCH', staffToken, {
    status: 'preparing'
  });
  console.log('Prepare result:', acceptRes2.status, acceptRes2.data);

  // 4. Staff marks ready (triggers assignment)
  console.log('\n4. Staff marks order ready...');
  const readyRes = await request(`/orders/${publicId}/status`, 'PATCH', staffToken, {
    status: 'ready'
  });
  console.log('Ready result:', readyRes.status, readyRes.data);

  // Give assignment loop a moment
  await new Promise(r => setTimeout(r, 1000));

  // 5. Check if agent is assigned
  console.log('\n5. Checking agent tasks...');
  const tasksRes = await request('/agents/tasks?status=assigned', 'GET', agentToken);
  console.log('Tasks result:', tasksRes.status, JSON.stringify(tasksRes.data, null, 2));

  // 6. Agent picks up
  console.log('\n6. Agent picks up order...');
  const pickRes = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentToken, {
    status: 'pickup'
  });
  console.log('Pickup result:', pickRes.status, pickRes.data);

  // 7. Agent delivers
  console.log('\n7. Agent delivers order...');
  const deliverRes = await request(`/orders/${publicId}/delivery-status`, 'PATCH', agentToken, {
    status: 'deliver'
  });
  console.log('Deliver result:', deliverRes.status, deliverRes.data);

  // 8. Agent checks earnings
  console.log('\n8. Agent checks earnings...');
  const earnRes = await request('/agents/earnings', 'GET', agentToken);
  console.log('Earnings result:', earnRes.status, JSON.stringify(earnRes.data, null, 2));

  // 9. Agent goes offline
  console.log('\n9. Agent goes offline...');
  const offlineRes = await request('/agents/presence/offline', 'POST', agentToken);
  console.log('Offline result:', offlineRes.status, offlineRes.data);
}

run().catch(console.error);
