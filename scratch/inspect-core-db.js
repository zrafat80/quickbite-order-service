const { Client } = require('pg');

async function go() {
  const c = new Client('postgresql://postgres:zeyiad123123@localhost:5432/myfirst');
  await c.connect();
  
  // Check branch columns
  const cols = await c.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='restaurant_branches' ORDER BY ordinal_position"
  );
  console.log('Columns:', cols.rows.map(r => `${r.column_name} (${r.data_type})`));
  
  // Get current data
  const branch = await c.query('SELECT * FROM restaurant_branches WHERE id=3');
  console.log('\nBranch 3:', JSON.stringify(branch.rows[0], null, 2));

  // Also check products
  const prod = await c.query('SELECT * FROM product_branch_details WHERE branch_id=3 AND product_id=1');
  console.log('\nProduct 1@Branch 3:', JSON.stringify(prod.rows[0], null, 2));

  const prodMain = await c.query('SELECT * FROM products WHERE id=1');
  console.log('\nProduct 1:', JSON.stringify(prodMain.rows[0], null, 2));
  
  await c.end();
}

go().catch(console.error);
