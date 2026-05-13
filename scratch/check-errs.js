const { Client } = require('pg');
const c = new Client('postgres://postgres:zeyiad123123@localhost:5432/order_service_eg');
c.connect().then(() => c.query('SELECT timestamp, "errorMessage", trace FROM logs WHERE "errorMessage" IS NOT NULL ORDER BY timestamp DESC LIMIT 5'))
.then(res => console.log(res.rows))
.finally(() => c.end());
