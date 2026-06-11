import request from 'supertest';
import { seedTransaction } from '../helpers/fixtures';
import { useOrderIntegrationApp } from '../helpers/test-app';

describe('Restaurant finance merged E2E/integration', () => {
  const testApp = useOrderIntegrationApp();
  const owner = (restaurantId = 3) =>
    testApp.authCookie({
      userId: 4,
      role: 'restaurant_user',
      email: 'owner@example.com',
      restaurantId,
      restaurantRole: 'owner',
      branchIds: [2],
    });
  const manager = () =>
    testApp.authCookie({
      userId: 5,
      role: 'restaurant_user',
      email: 'manager@example.com',
      restaurantId: 3,
      restaurantRole: 'branch_manager',
      branchIds: [2],
    });
  const customer = () =>
    testApp.authCookie({
      userId: 7,
      role: 'customer',
      email: 'customer@example.com',
    });

  async function seedBalance(balance: number, restaurantId = 3) {
    const [row] = await testApp.database('restaurant_balances')
      .insert({
        region: 'eg',
        restaurant_id: restaurantId,
        currency: 'EGP',
        balance,
        updated_at: new Date(),
      })
      .returning('*');
    return row;
  }

  describe('GET /api/restaurants/:restaurantId/balance', () => {
    it('Zone 1 - reads the persisted restaurant balance', async () => {
      await seedBalance(5500);
      const response = await request(testApp.app.getHttpServer())
        .get('/api/restaurants/3/balance')
        .set('Cookie', owner())
        .set('x-region', 'eg');

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        restaurantId: '3',
        currency: 'EGP',
        balance: 5500,
      });
    });

    it('Zone 2 - rejects a nonnumeric restaurant id', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/restaurants/not-a-number/balance')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .expect(400);
    });

    it('Zone 3 - rejects no token, wrong roles, and cross-tenant access', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/restaurants/3/balance')
        .set('x-region', 'eg')
        .expect(401);
      await request(testApp.app.getHttpServer())
        .get('/api/restaurants/3/balance')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .expect(403);
      await request(testApp.app.getHttpServer())
        .get('/api/restaurants/3/balance')
        .set('Cookie', owner(99))
        .set('x-region', 'eg')
        .expect(403);
    });

    it('Zone 4 - returns a zero projection when no balance row exists', async () => {
      const response = await request(testApp.app.getHttpServer())
        .get('/api/restaurants/3/balance?currency=USD')
        .set('Cookie', owner())
        .set('x-region', 'eg');

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        restaurantId: '3',
        currency: 'USD',
        balance: 0,
      });
      expect(await testApp.database('restaurant_balances')).toHaveLength(0);
    });
  });

  describe('GET /api/restaurants/:restaurantId/payouts', () => {
    it('Zone 1 - lists persisted payout transactions for the restaurant', async () => {
      const payout = await seedTransaction(testApp.database, null, {
        transaction_type: 'payout',
        method: 'bank_transfer',
        provider_id: null,
        provider_reference_id: null,
        status: 'succeeded',
        amount: 2000,
        src_acc_id: 3,
        dst_acc_id: null,
        created_at: new Date('2026-06-05T10:00:00.000Z'),
        updated_at: new Date('2026-06-05T10:00:00.000Z'),
      });

      const response = await request(testApp.app.getHttpServer())
        .get('/api/restaurants/3/payouts?from=2026-06-01&to=2026-06-30')
        .set('Cookie', owner())
        .set('x-region', 'eg');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([
        expect.objectContaining({ id: String(payout.id), amount: 2000 }),
      ]);
    });

    it('Zone 2 - rejects malformed ids and invalid date ranges', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/restaurants/nope/payouts')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .expect(400);
      await request(testApp.app.getHttpServer())
        .get('/api/restaurants/3/payouts?from=bad')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .expect(400);
      await request(testApp.app.getHttpServer())
        .get('/api/restaurants/3/payouts?from=2026-06-30&to=2026-06-01')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .expect(400);
    });

    it('Zone 3 - rejects no token, missing permissions, and another tenant', async () => {
      const path = '/api/restaurants/3/payouts';
      await request(testApp.app.getHttpServer())
        .get(path)
        .set('x-region', 'eg')
        .expect(401);
      await request(testApp.app.getHttpServer())
        .get(path)
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .expect(403);
      await request(testApp.app.getHttpServer())
        .get(path)
        .set('Cookie', owner(99))
        .set('x-region', 'eg')
        .expect(403);
    });

    it('Zone 4 - excludes other restaurants, non-payouts, and out-of-range rows', async () => {
      const own = await seedTransaction(testApp.database, null, {
        transaction_type: 'payout',
        method: 'bank_transfer',
        provider_id: null,
        provider_reference_id: null,
        src_acc_id: 3,
        created_at: new Date('2026-06-05T10:00:00.000Z'),
        updated_at: new Date('2026-06-05T10:00:00.000Z'),
      });
      await seedTransaction(testApp.database, null, {
        transaction_type: 'payout',
        method: 'bank_transfer',
        provider_id: null,
        provider_reference_id: null,
        src_acc_id: 99,
        created_at: new Date('2026-06-06T10:00:00.000Z'),
        updated_at: new Date('2026-06-06T10:00:00.000Z'),
      });
      await seedTransaction(testApp.database, null, {
        transaction_type: 'adjustment',
        method: 'system',
        provider_id: null,
        provider_reference_id: null,
        src_acc_id: 3,
        created_at: new Date('2026-06-07T10:00:00.000Z'),
        updated_at: new Date('2026-06-07T10:00:00.000Z'),
      });

      const response = await request(testApp.app.getHttpServer())
        .get('/api/restaurants/3/payouts?from=2026-06-01&to=2026-06-30')
        .set('Cookie', owner())
        .set('x-region', 'eg');
      expect(response.body.data.map((row: any) => row.id)).toEqual([
        String(own.id),
      ]);
    });
  });

  describe('POST /api/restaurants/:restaurantId/payouts', () => {
    const payload = {
      amount: 2000,
      currency: 'EGP',
      method: 'bank_transfer',
      dst: 'EG123456789',
    };

    it('Zone 1 - locks and deducts balance while creating a payout ledger row', async () => {
      await seedBalance(5000);
      const response = await request(testApp.app.getHttpServer())
        .post('/api/restaurants/3/payouts')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payout-1')
        .send(payload);

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        amount: 2000,
        currency: 'EGP',
        method: 'bank_transfer',
      });
      await expect(
        testApp.database('restaurant_balances').where({ restaurant_id: 3 }).first(),
      ).resolves.toMatchObject({ balance: '3000' });
      await expect(
        testApp.database('transactions').where({
          transaction_type: 'payout',
          src_acc_id: 3,
        }).first(),
      ).resolves.toMatchObject({
        amount: 2000,
        status: 'succeeded',
        idempotency_key: 'payout-1',
      });
    });

    it('Zone 2 - rejects malformed ids, invalid bodies, and missing idempotency keys', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/restaurants/nope/payouts')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payout-invalid-id')
        .send(payload)
        .expect(400);
      await request(testApp.app.getHttpServer())
        .post('/api/restaurants/3/payouts')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payout-invalid-body')
        .send({ amount: -1, currency: '', method: '', dst: '' })
        .expect(400);
      await request(testApp.app.getHttpServer())
        .post('/api/restaurants/3/payouts')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .send(payload)
        .expect(400);
    });

    it('Zone 3 - rejects no token, missing payout permission, and cross-tenant access', async () => {
      const path = '/api/restaurants/3/payouts';
      await request(testApp.app.getHttpServer())
        .post(path)
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payout-no-auth')
        .send(payload)
        .expect(401);
      await request(testApp.app.getHttpServer())
        .post(path)
        .set('Cookie', manager())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payout-manager')
        .send(payload)
        .expect(403);
      await request(testApp.app.getHttpServer())
        .post(path)
        .set('Cookie', owner(99))
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payout-cross-tenant')
        .send(payload)
        .expect(403);
    });

    it('Zone 4 - rejects overdrafts and makes payout replay idempotent', async () => {
      await seedBalance(1000);
      await request(testApp.app.getHttpServer())
        .post('/api/restaurants/3/payouts')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payout-overdraft')
        .send(payload)
        .expect(409);

      await testApp.database('restaurant_balances')
        .where({ restaurant_id: 3 })
        .update({ balance: 5000 });
      const first = await request(testApp.app.getHttpServer())
        .post('/api/restaurants/3/payouts')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payout-replay')
        .send(payload);
      const replay = await request(testApp.app.getHttpServer())
        .post('/api/restaurants/3/payouts')
        .set('Cookie', owner())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payout-replay')
        .send(payload);

      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(
        await testApp.database('transactions').where({
          idempotency_key: 'payout-replay',
        }),
      ).toHaveLength(1);
      await expect(
        testApp.database('restaurant_balances').where({ restaurant_id: 3 }).first(),
      ).resolves.toMatchObject({ balance: '3000' });
    });
  });
});
