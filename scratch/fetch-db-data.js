const { Client } = require('pg');

async function seedTestData() {
  const c = new Client('postgres://postgres:zeyiad123123@localhost:5432/myfirst');
  await c.connect();

  // Create Staff
  const staffRes = await c.query(`
    INSERT INTO users (name, email, phone, system_role, password_hash, created_at, updated_at)
    VALUES ('Test Staff', 'staff@example.com', '+201000000001', 'restaurant_user', 'hash', NOW(), NOW())
    ON CONFLICT (email) DO UPDATE SET system_role = 'restaurant_user'
    RETURNING id;
  `);
  const staffId = staffRes.rows[0].id;

  // Create Agent
  const agentRes = await c.query(`
    INSERT INTO users (name, email, phone, system_role, password_hash, created_at, updated_at)
    VALUES ('Test Agent', 'agent@example.com', '+201000000002', 'delivery_agent', 'hash', NOW(), NOW())
    ON CONFLICT (email) DO UPDATE SET system_role = 'delivery_agent'
    RETURNING id;
  `);
  const agentId = agentRes.rows[0].id;

  console.log(`Seeded Staff ID: ${staffId}, Agent ID: ${agentId}`);

  // Fetch branch details
  const branchUserRes = await c.query('SELECT restaurant_id FROM restaurant_branches WHERE id = 3');
  const restaurantId = branchUserRes.rows[0]?.restaurant_id || 1;

  await c.end();
}

seedTestData().catch(console.error);
