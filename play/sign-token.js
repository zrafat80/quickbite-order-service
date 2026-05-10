// Sign a test JWT for the order-service curl flows. The signing secret matches
// core-service's JWT_ACCESS_SECRET / order-service's ACCESS_SECRET so tokens
// minted here are accepted by both services' JwtAuthGuard.
//
// Usage:
//   node play/sign-token.js <userId> <role> [extraJsonClaims]
//   e.g. node play/sign-token.js 5 customer
//        node play/sign-token.js 23 restaurant_user '{"restaurantId":3,"restaurantRole":"owner"}'

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');

const userId = Number(process.argv[2]);
const role = process.argv[3];
const extra = process.argv[4] ? JSON.parse(process.argv[4]) : {};

if (!userId || !role) {
  console.error(
    'usage: node play/sign-token.js <userId> <role> [extraJsonClaims]',
  );
  process.exit(1);
}

const payload = {
  userId,
  role,
  email: `test+${userId}@example.com`,
  ...extra,
};

const secret = process.env.ACCESS_SECRET;
if (!secret) {
  console.error('ACCESS_SECRET missing from .env');
  process.exit(1);
}

const token = jwt.sign(payload, secret, { expiresIn: '1h' });
process.stdout.write(token);
