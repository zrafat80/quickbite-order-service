const { Client } = require('pg');

async function go() {
  const c = new Client('postgresql://postgres:zeyiad123123@localhost:5432/myfirst');
  await c.connect();
  
  // commission = 2000 bps = 20% (platform's cut)
  // Agent gets the remaining 80%
  await c.query('UPDATE restaurant_branches SET commission=2000 WHERE id=3');
  
  const r = await c.query('SELECT id, delivery_fee, commission, currency FROM restaurant_branches WHERE id=3');
  console.log('Branch 3:', r.rows[0]);
  
  await c.end();
  console.log('Done!');
}

go().catch(console.error);
