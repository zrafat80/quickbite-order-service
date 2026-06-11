import request from 'supertest';
import {
  seedOrder,
  seedOrderItem,
  seedPaymentSession,
  seedTransaction,
} from '../helpers/fixtures';
import { useOrderIntegrationApp } from '../helpers/test-app';

describe('Payment merged E2E/integration', () => {
  const testApp = useOrderIntegrationApp();
  const customer = (userId = 7) =>
    testApp.authCookie({
      userId,
      role: 'customer',
      email: `customer${userId}@example.com`,
    });
  const admin = () =>
    testApp.authCookie({
      userId: 1,
      role: 'system_admin',
      email: 'admin@example.com',
    });
  const restaurant = (restaurantId = 3) =>
    testApp.authCookie({
      userId: 4,
      role: 'restaurant_user',
      email: 'owner@example.com',
      restaurantId,
      restaurantRole: 'owner',
      branchIds: [2],
    });

  describe('POST /api/payments/init', () => {
    it('Zone 1 - creates a real provider session and persists it', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'pending_payment',
        payment_method: 'online',
      });

      const response = await request(testApp.app.getHttpServer())
        .post('/api/payments/init')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payment-init-1')
        .send({ orderId: order.public_id });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        providerSessionId: 'session-1',
        amount: 1100,
        currency: 'EGP',
      });
      await expect(
        testApp.database('payment_sessions').where({ order_id: order.id }).first(),
      ).resolves.toMatchObject({
        provider_session_id: 'session-1',
        status: 'initialized',
      });
      expect(
        testApp.external.requests.some(
          (entry) => entry.method === 'POST' && entry.path === '/v3/payment/sessions',
        ),
      ).toBe(true);
    });

    it('Zone 2 - rejects missing and malformed order UUIDs', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/payments/init')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payment-init-invalid-1')
        .send({})
        .expect(400);

      await request(testApp.app.getHttpServer())
        .post('/api/payments/init')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payment-init-invalid-2')
        .send({ orderId: 'not-a-uuid' })
        .expect(400);
    });

    it('Zone 3 - enforces authentication and order ownership', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'pending_payment',
        payment_method: 'online',
      });

      await request(testApp.app.getHttpServer())
        .post('/api/payments/init')
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payment-init-no-auth')
        .send({ orderId: order.public_id })
        .expect(401);

      await request(testApp.app.getHttpServer())
        .post('/api/payments/init')
        .set('Cookie', customer(8))
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payment-init-cross-tenant')
        .send({ orderId: order.public_id })
        .expect(403);

      expect(await testApp.database('payment_sessions')).toHaveLength(0);
    });

    it('Zone 4 - rejects COD orders and disabled payment providers', async () => {
      const codOrder = await seedOrder(testApp.database);
      await request(testApp.app.getHttpServer())
        .post('/api/payments/init')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payment-init-cod')
        .send({ orderId: codOrder.public_id })
        .expect(409);

      const onlineOrder = await seedOrder(testApp.database, {
        public_id: '22222222-2222-4222-8222-222222222222',
        status: 'pending_payment',
        payment_method: 'online',
        created_at: new Date('2026-05-02T10:00:00.000Z'),
        updated_at: new Date('2026-05-02T10:00:00.000Z'),
      });
      await testApp.database('payment_providers').where({ id: 1 }).update({
        is_enabled: false,
      });

      await request(testApp.app.getHttpServer())
        .post('/api/payments/init')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'payment-init-disabled')
        .send({ orderId: onlineOrder.public_id })
        .expect(409);
    });
  });

  describe('GET /api/payments/:id', () => {
    it('Zone 1 - reads a transaction and joins its order/provider context', async () => {
      const order = await seedOrder(testApp.database);
      const transaction = await seedTransaction(testApp.database, order);

      const response = await request(testApp.app.getHttpServer())
        .get(`/api/payments/${transaction.id}`)
        .set('Cookie', restaurant())
        .set('x-region', 'eg');

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: Number(transaction.id),
        orderPublicId: order.public_id,
        provider: 'kashier',
        amount: 1100,
      });
    });

    it('Zone 2 - rejects a nonnumeric transaction id', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/payments/not-a-number')
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .expect(400);
    });

    it('Zone 3 - rejects no token, customer access, and another restaurant', async () => {
      const order = await seedOrder(testApp.database);
      const transaction = await seedTransaction(testApp.database, order);
      const path = `/api/payments/${transaction.id}`;

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
        .set('Cookie', restaurant(99))
        .set('x-region', 'eg')
        .expect(403);
    });

    it('Zone 4 - returns 404 for an unknown transaction', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/payments/999999')
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .expect(404);
    });
  });

  describe('POST /api/payments/:id/refund', () => {
    it('Zone 1 - creates and commits a COD refund transaction', async () => {
      const order = await seedOrder(testApp.database);
      const charge = await seedTransaction(testApp.database, order, {
        transaction_type: 'charge',
        method: 'cod',
        provider_id: 2,
        provider_reference_id: null,
        provider_order_id: null,
      });

      const response = await request(testApp.app.getHttpServer())
        .post(`/api/payments/${charge.id}/refund`)
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'refund-cod-1')
        .send({ amount: 400, reason: 'Missing item' });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        status: 'succeeded',
        amount: 400,
        currency: 'EGP',
      });
      await expect(
        testApp.database('transactions').where({
          refunded_payment_id: charge.id,
          transaction_type: 'refund',
        }).first(),
      ).resolves.toMatchObject({
        status: 'succeeded',
        amount: 400,
        idempotency_key: 'refund-cod-1',
      });
    });

    it('Zone 2 - rejects malformed ids, zero amounts, and empty reasons', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/payments/not-a-number/refund')
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'refund-invalid-id')
        .send({ amount: 1, reason: 'Reason' })
        .expect(400);

      await request(testApp.app.getHttpServer())
        .post('/api/payments/1/refund')
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'refund-invalid-body')
        .send({ amount: 0, reason: '' })
        .expect(400);
    });

    it('Zone 3 - rejects missing auth and non-admin actors', async () => {
      const order = await seedOrder(testApp.database);
      const charge = await seedTransaction(testApp.database, order, {
        method: 'cod',
        provider_id: 2,
      });
      const path = `/api/payments/${charge.id}/refund`;

      await request(testApp.app.getHttpServer())
        .post(path)
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'refund-no-auth')
        .send({ amount: 100, reason: 'Reason' })
        .expect(401);

      await request(testApp.app.getHttpServer())
        .post(path)
        .set('Cookie', restaurant())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'refund-wrong-role')
        .send({ amount: 100, reason: 'Reason' })
        .expect(403);
    });

    it('Zone 4 - rejects over-refunds and ineligible transactions', async () => {
      const order = await seedOrder(testApp.database);
      const charge = await seedTransaction(testApp.database, order, {
        method: 'cod',
        provider_id: 2,
        amount: 500,
      });
      await request(testApp.app.getHttpServer())
        .post(`/api/payments/${charge.id}/refund`)
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'refund-too-large')
        .send({ amount: 501, reason: 'Too much' })
        .expect(409);

      const failedCharge = await seedTransaction(testApp.database, order, {
        provider_reference_id: 'failed-charge',
        status: 'failed',
        created_at: new Date('2026-05-02T10:00:00.000Z'),
        updated_at: new Date('2026-05-02T10:00:00.000Z'),
      });
      await request(testApp.app.getHttpServer())
        .post(`/api/payments/${failedCharge.id}/refund`)
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .set('Idempotency-Key', 'refund-ineligible')
        .send({ amount: 100, reason: 'Failed charge' })
        .expect(409);
    });
  });

  describe('POST /api/payments/internal/sweeper/run', () => {
    it('Zone 1 - expires stale sessions and cancels abandoned orders in one transaction', async () => {
      const old = new Date(Date.now() - 60 * 60_000);
      const order = await seedOrder(testApp.database, {
        status: 'pending_payment',
        payment_method: 'online',
        created_at: old,
        updated_at: old,
      });
      await seedPaymentSession(testApp.database, order, {
        expires_at: new Date(Date.now() - 5 * 60_000),
        created_at: old,
        updated_at: old,
      });

      const response = await request(testApp.app.getHttpServer())
        .post('/api/payments/internal/sweeper/run')
        .set('x-api-key', 'test-internal-key')
        .set('x-region', 'eg');

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        region: 'eg',
        sessionsExpired: 1,
        ordersCancelled: 1,
      });
      await expect(
        testApp.database('orders').where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'cancelled' });
      await expect(
        testApp.database('payment_sessions').where({ order_id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'expired' });
    });

    it('Zone 2 - ignores unknown body fields and preserves deterministic output', async () => {
      const response = await request(testApp.app.getHttpServer())
        .post('/api/payments/internal/sweeper/run')
        .set('x-api-key', 'test-internal-key')
        .set('x-region', 'eg')
        .send({ graceMinutes: -1, unexpected: true });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        sessionsExpired: 0,
        ordersCancelled: 0,
      });
    });

    it('Zone 3 - rejects missing and incorrect internal API keys', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/payments/internal/sweeper/run')
        .set('x-region', 'eg')
        .expect(401);

      await request(testApp.app.getHttpServer())
        .post('/api/payments/internal/sweeper/run')
        .set('x-api-key', 'wrong')
        .set('x-region', 'eg')
        .expect(401);
    });

    it('Zone 4 - does not cancel an order with a live payment session', async () => {
      const old = new Date(Date.now() - 60 * 60_000);
      const order = await seedOrder(testApp.database, {
        status: 'pending_payment',
        payment_method: 'online',
        created_at: old,
        updated_at: old,
      });
      await seedPaymentSession(testApp.database, order, {
        expires_at: new Date(Date.now() + 5 * 60_000),
        created_at: old,
        updated_at: old,
      });

      const response = await request(testApp.app.getHttpServer())
        .post('/api/payments/internal/sweeper/run')
        .set('x-api-key', 'test-internal-key')
        .set('x-region', 'eg');

      expect(response.body.data.ordersCancelled).toBe(0);
      await expect(
        testApp.database('orders').where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'pending_payment' });
    });
  });

  describe('POST /api/payments/webhook/:provider', () => {
    function captureBody(orderId: string) {
      return {
        event: 'pay',
        data: {
          merchantOrderId: orderId,
          transactionId: 'capture-1',
          kashierOrderId: 'kashier-order-1',
          status: 'SUCCESS',
          amount: '11',
          currency: 'EGP',
          signatureKeys: [
            'merchantOrderId',
            'transactionId',
            'kashierOrderId',
            'status',
            'amount',
            'currency',
          ],
        },
      };
    }

    it('Zone 1 - captures payment, advances the order, audits the event, and reserves stock', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'pending_payment',
        payment_method: 'online',
      });
      await seedOrderItem(testApp.database, order);
      await seedPaymentSession(testApp.database, order);
      const body = captureBody(order.public_id);

      const response = await request(testApp.app.getHttpServer())
        .post('/api/payments/webhook/kashier')
        .set('x-kashier-signature', testApp.external.webhookSignature(body.data))
        .send(body);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ ok: true });
      await expect(
        testApp.database('orders').where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'placed' });
      await expect(
        testApp.database('payment_sessions').where({ order_id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'captured' });
      await expect(
        testApp.database('transactions').where({
          order_id: order.id,
          transaction_type: 'charge',
        }).first(),
      ).resolves.toMatchObject({
        status: 'succeeded',
        provider_reference_id: 'capture-1',
      });
      await expect(
        testApp.database('payment_webhook_events').first(),
      ).resolves.toMatchObject({ event_type: 'pay' });
      expect(testApp.external.products.get(2)!.get(12)!.stock).toBe(18);
    });

    it('records a signed provider failure without placing the order or reserving stock', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'pending_payment',
        payment_method: 'online',
      });
      await seedOrderItem(testApp.database, order);
      await seedPaymentSession(testApp.database, order);
      const body = captureBody(order.public_id);
      body.data.transactionId = 'failed-capture-1';
      body.data.status = 'FAILED';

      const response = await request(testApp.app.getHttpServer())
        .post('/api/payments/webhook/kashier')
        .set('x-kashier-signature', testApp.external.webhookSignature(body.data))
        .send(body);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ ok: true });
      await expect(
        testApp.database('orders').where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'pending_payment' });
      await expect(
        testApp.database('payment_sessions').where({ order_id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'failed' });
      await expect(
        testApp.database('transactions').where({
          order_id: order.id,
          transaction_type: 'charge',
        }).first(),
      ).resolves.toMatchObject({
        status: 'failed',
        provider_reference_id: 'failed-capture-1',
      });
      await expect(
        testApp.database('payment_webhook_events').first(),
      ).resolves.toMatchObject({
        event_type: 'pay',
        processed_at: expect.any(Date),
        process_error: null,
      });
      expect(
        await testApp.database('events_outbox').where({
          aggregate_id: order.public_id,
          event_type: 'payment.completed',
        }),
      ).toHaveLength(0);
      expect(testApp.external.products.get(2)!.get(12)!.stock).toBe(20);
      expect(
        testApp.external.requests.some(
          (entry) =>
            entry.method === 'POST' &&
            entry.path === '/api/internal/branches/2/reserve-stock',
        ),
      ).toBe(false);
      expect(testApp.wsGateway.emitted).toEqual([
        expect.objectContaining({
          channel: 'customer:7',
          event: 'payment.failed',
        }),
      ]);
    });

    it('Zone 2 - rejects unknown providers and malformed signed payloads', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/payments/webhook/unknown')
        .send({})
        .expect(400);

      const body = {
        event: 'pay',
        data: {
          status: 'SUCCESS',
          signatureKeys: ['status'],
        },
      };
      await request(testApp.app.getHttpServer())
        .post('/api/payments/webhook/kashier')
        .set('x-kashier-signature', testApp.external.webhookSignature(body.data))
        .send(body)
        .expect(400);
    });

    it('Zone 3 - rejects a webhook with an invalid provider signature', async () => {
      const body = captureBody('33333333-3333-4333-8333-333333333333');
      await request(testApp.app.getHttpServer())
        .post('/api/payments/webhook/kashier')
        .set('x-kashier-signature', 'invalid')
        .send(body)
        .expect(401);

      expect(await testApp.database('payment_webhook_events')).toHaveLength(0);
    });

    it('Zone 4 - deduplicates a replay without duplicating ledger rows', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'pending_payment',
        payment_method: 'online',
      });
      await seedOrderItem(testApp.database, order);
      await seedPaymentSession(testApp.database, order);
      const body = captureBody(order.public_id);
      const signature = testApp.external.webhookSignature(body.data);

      await request(testApp.app.getHttpServer())
        .post('/api/payments/webhook/kashier')
        .set('x-kashier-signature', signature)
        .send(body)
        .expect(200);
      const replay = await request(testApp.app.getHttpServer())
        .post('/api/payments/webhook/kashier')
        .set('x-kashier-signature', signature)
        .send(body);

      expect(replay.status).toBe(200);
      expect(replay.body.data).toEqual({ ok: true, alreadyProcessed: true });
      expect(
        await testApp.database('transactions').where({
          order_id: order.id,
          transaction_type: 'charge',
        }),
      ).toHaveLength(1);
      expect(await testApp.database('payment_webhook_events')).toHaveLength(1);
    });
  });
});
