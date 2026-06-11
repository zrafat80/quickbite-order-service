import request from 'supertest';
import { randomUUID } from 'crypto';
import { seedOrder } from '../helpers/fixtures';
import { useOrderIntegrationApp } from '../helpers/test-app';

describe('Agent merged E2E/integration', () => {
  const testApp = useOrderIntegrationApp();
  const agent = (userId = 22) =>
    testApp.authCookie({
      userId,
      role: 'delivery_agent',
      email: `agent${userId}@example.com`,
    });
  const customer = () =>
    testApp.authCookie({
      userId: 7,
      role: 'customer',
      email: 'customer@example.com',
    });
  const admin = () =>
    testApp.authCookie({
      userId: 1,
      role: 'system_admin',
      email: 'admin@example.com',
    });
  const staff = () =>
    testApp.authCookie({
      userId: 5,
      role: 'restaurant_user',
      email: 'staff@example.com',
      restaurantId: 3,
      restaurantRole: 'staff',
      branchIds: [2],
    });

  async function markOnline(userId: number, lat = 30.0444, lng = 31.2357) {
    await request(testApp.app.getHttpServer())
      .post('/api/agents/presence/online')
      .set('Cookie', agent(userId))
      .set('x-region', 'eg')
      .send({ lat, lng })
      .expect(201);
  }

  describe('POST /api/agents/presence/online', () => {
    it('Zone 1 - upserts durable online presence with coordinates', async () => {
      const response = await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/online')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ lat: '30.0444', lng: '31.2357' });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ ok: true });
      await expect(
        testApp.database('agent_presence').where({ agent_id: 22 }).first(),
      ).resolves.toMatchObject({
        region: 'eg',
        is_online: true,
        last_lat: '30.0444000',
        last_lng: '31.2357000',
      });
    });

    it('Zone 2 - rejects missing and out-of-range coordinates', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/online')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ lat: 100, lng: -200 })
        .expect(400);
      expect(await testApp.database('agent_presence')).toHaveLength(0);
    });

    it('Zone 3 - rejects missing auth and non-agent roles', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/online')
        .set('x-region', 'eg')
        .send({ lat: 30, lng: 31 })
        .expect(401);
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/online')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .send({ lat: 30, lng: 31 })
        .expect(403);
    });

    it('Zone 4 - repeated online calls update one row rather than duplicating it', async () => {
      await markOnline(22);
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/online')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ lat: 30.1, lng: 31.3 })
        .expect(201);

      const rows = await testApp.database('agent_presence').where({ agent_id: 22 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        last_lat: '30.1000000',
        last_lng: '31.3000000',
      });
    });
  });

  describe('POST /api/agents/presence/offline', () => {
    it('Zone 1 - marks an online agent offline in PostgreSQL', async () => {
      await markOnline(22);

      const response = await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/offline')
        .set('Cookie', agent())
        .set('x-region', 'eg');

      expect(response.status).toBe(201);
      await expect(
        testApp.database('agent_presence').where({ agent_id: 22 }).first(),
      ).resolves.toMatchObject({ is_online: false });
    });

    it('Zone 2 - rejects a request without a valid region header', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/offline')
        .set('Cookie', agent())
        .expect(400);
    });

    it('Zone 3 - rejects missing auth and non-agent roles', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/offline')
        .set('x-region', 'eg')
        .expect(401);
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/offline')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .expect(403);
    });

    it('Zone 4 - blocks offline while the agent holds a picked order', async () => {
      await markOnline(22);
      await seedOrder(testApp.database, {
        status: 'picked',
        delivery_agent_id: 22,
        assigned_at: new Date(),
        picked_at: new Date(),
      });

      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/offline')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .expect(409);
      await expect(
        testApp.database('agent_presence').where({ agent_id: 22 }).first(),
      ).resolves.toMatchObject({ is_online: true });
    });
  });

  describe('POST /api/agents/presence/ping', () => {
    it('Zone 1 - updates the online agent heartbeat and location', async () => {
      await markOnline(22);
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/ping')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ lat: 30.2, lng: 31.4 })
        .expect(201);

      await expect(
        testApp.database('agent_presence').where({ agent_id: 22 }).first(),
      ).resolves.toMatchObject({
        is_online: true,
        last_lat: '30.2000000',
        last_lng: '31.4000000',
      });
    });

    it('Zone 2 - rejects invalid coordinate payloads', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/ping')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ lat: 'north', lng: null })
        .expect(400);
    });

    it('Zone 3 - rejects missing auth and non-agent roles', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/ping')
        .set('x-region', 'eg')
        .send({ lat: 30, lng: 31 })
        .expect(401);
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/ping')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .send({ lat: 30, lng: 31 })
        .expect(403);
    });

    it('Zone 4 - rejects a heartbeat from an agent who is not online', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/agents/presence/ping')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ lat: 30, lng: 31 })
        .expect(409);
    });
  });

  describe('GET /api/agents/tasks', () => {
    it('Zone 1 - returns persisted tasks assigned to the authenticated agent', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'assigned',
        delivery_agent_id: 22,
        assigned_at: new Date(),
      });

      const response = await request(testApp.app.getHttpServer())
        .get('/api/agents/tasks?status=assigned')
        .set('Cookie', agent())
        .set('x-region', 'eg');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([
        expect.objectContaining({
          orderId: order.public_id,
          status: 'assigned',
          branchId: 2,
        }),
      ]);
    });

    it('Zone 2 - rejects an invalid status query', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/agents/tasks?status=flying')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .expect(400);
    });

    it('Zone 3 - rejects missing auth and non-agent roles', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/agents/tasks')
        .set('x-region', 'eg')
        .expect(401);
      await request(testApp.app.getHttpServer())
        .get('/api/agents/tasks')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .expect(403);
    });

    it('Zone 4 - isolates another agent’s assigned tasks', async () => {
      const own = await seedOrder(testApp.database, {
        status: 'assigned',
        delivery_agent_id: 22,
        assigned_at: new Date(),
      });
      await seedOrder(testApp.database, {
        public_id: randomUUID(),
        status: 'assigned',
        delivery_agent_id: 23,
        assigned_at: new Date(),
        created_at: new Date('2026-05-02T10:00:00.000Z'),
        updated_at: new Date('2026-05-02T10:00:00.000Z'),
      });

      const response = await request(testApp.app.getHttpServer())
        .get('/api/agents/tasks')
        .set('Cookie', agent())
        .set('x-region', 'eg');
      expect(response.body.data.map((row: any) => row.orderId)).toEqual([
        own.public_id,
      ]);
    });
  });

  describe('GET /api/agents/earnings', () => {
    async function seedEarning(agentId: number, earnedAt: Date) {
      const order = await seedOrder(testApp.database, {
        status: 'delivered',
        delivery_agent_id: agentId,
        assigned_at: earnedAt,
        picked_at: earnedAt,
        delivered_at: earnedAt,
        created_at: earnedAt,
        updated_at: earnedAt,
      });
      await testApp.database('agent_earnings').insert({
        region: 'eg',
        agent_id: agentId,
        order_id: order.id,
        order_created_at: order.created_at,
        amount: 80,
        currency: 'EGP',
        earned_at: earnedAt,
      });
      return order;
    }

    it('Zone 1 - returns persisted earnings and aggregate totals', async () => {
      const order = await seedEarning(22, new Date('2026-06-01T10:00:00.000Z'));
      const response = await request(testApp.app.getHttpServer())
        .get('/api/agents/earnings?from=2026-06-01&to=2026-06-30')
        .set('Cookie', agent())
        .set('x-region', 'eg');

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        totals: { count: 1, sum: 80, currency: 'EGP' },
        items: [expect.objectContaining({ orderPublicId: order.public_id, amount: 80 })],
      });
    });

    it('Zone 2 - rejects invalid and reversed date ranges', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/agents/earnings?from=bad')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .expect(400);
      await request(testApp.app.getHttpServer())
        .get('/api/agents/earnings?from=2026-06-10&to=2026-06-01')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .expect(400);
    });

    it('Zone 3 - rejects missing auth and non-agent roles', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/agents/earnings')
        .set('x-region', 'eg')
        .expect(401);
      await request(testApp.app.getHttpServer())
        .get('/api/agents/earnings')
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .expect(403);
    });

    it('Zone 4 - excludes another agent and out-of-range earnings', async () => {
      await seedEarning(22, new Date('2026-06-01T10:00:00.000Z'));
      await seedEarning(23, new Date('2026-06-02T10:00:00.000Z'));
      await seedEarning(22, new Date('2026-05-01T10:00:00.000Z'));

      const response = await request(testApp.app.getHttpServer())
        .get('/api/agents/earnings?from=2026-06-01&to=2026-06-30')
        .set('Cookie', agent())
        .set('x-region', 'eg');
      expect(response.body.data.totals).toMatchObject({ count: 1, sum: 80 });
      expect(response.body.data.items).toHaveLength(1);
    });
  });

  describe('PATCH /api/orders/:publicId/delivery-status', () => {
    it('Zone 1 - lets the assigned agent pick up an order and commits the transition', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'assigned',
        delivery_agent_id: 22,
        accepted_at: new Date(),
        assigned_at: new Date(),
      });

      const response = await request(testApp.app.getHttpServer())
        .patch(`/api/orders/${order.public_id}/delivery-status`)
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ status: 'pickup' });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: order.public_id,
        status: 'picked',
      });
      await expect(
        testApp.database('orders').where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'picked' });
    });

    it('Zone 2 - rejects malformed UUIDs and invalid actions', async () => {
      await request(testApp.app.getHttpServer())
        .patch('/api/orders/not-a-uuid/delivery-status')
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ status: 'pickup' })
        .expect(400);
      const order = await seedOrder(testApp.database, {
        status: 'assigned',
        delivery_agent_id: 22,
      });
      await request(testApp.app.getHttpServer())
        .patch(`/api/orders/${order.public_id}/delivery-status`)
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ status: 'fly' })
        .expect(400);
    });

    it('Zone 3 - rejects no token, wrong role, and another agent', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'assigned',
        delivery_agent_id: 22,
      });
      const path = `/api/orders/${order.public_id}/delivery-status`;
      await request(testApp.app.getHttpServer())
        .patch(path)
        .set('x-region', 'eg')
        .send({ status: 'accept' })
        .expect(401);
      await request(testApp.app.getHttpServer())
        .patch(path)
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .send({ status: 'accept' })
        .expect(403);
      await request(testApp.app.getHttpServer())
        .patch(path)
        .set('Cookie', agent(23))
        .set('x-region', 'eg')
        .send({ status: 'accept' })
        .expect(403);
    });

    it('Zone 4 - rejects pickup when the assigned order is not in assigned state', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'placed',
        delivery_agent_id: 22,
      });
      await request(testApp.app.getHttpServer())
        .patch(`/api/orders/${order.public_id}/delivery-status`)
        .set('Cookie', agent())
        .set('x-region', 'eg')
        .send({ status: 'pickup' })
        .expect(409);
    });
  });

  describe('POST /api/orders/:publicId/assign', () => {
    it('Zone 1 - assigns a ready order to an online agent transactionally', async () => {
      await markOnline(22);
      const order = await seedOrder(testApp.database, {
        status: 'ready',
        ready_at: new Date(),
      });

      const response = await request(testApp.app.getHttpServer())
        .post(`/api/orders/${order.public_id}/assign`)
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .send({ agentId: 22 });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        orderId: order.public_id,
        status: 'assigned',
        deliveryAgentId: 22,
      });
      await expect(
        testApp.database('orders').where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'assigned', delivery_agent_id: '22' });
    });

    it('Zone 2 - rejects malformed UUIDs and invalid agent ids', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/orders/not-a-uuid/assign')
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .send({ agentId: 22 })
        .expect(400);
      const order = await seedOrder(testApp.database, { status: 'ready' });
      await request(testApp.app.getHttpServer())
        .post(`/api/orders/${order.public_id}/assign`)
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .send({ agentId: -1 })
        .expect(400);
    });

    it('Zone 3 - rejects no token and actors without delivery assignment permission', async () => {
      const order = await seedOrder(testApp.database, { status: 'ready' });
      const path = `/api/orders/${order.public_id}/assign`;
      await request(testApp.app.getHttpServer())
        .post(path)
        .set('x-region', 'eg')
        .send({ agentId: 22 })
        .expect(401);
      await request(testApp.app.getHttpServer())
        .post(path)
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .send({ agentId: 22 })
        .expect(403);
      await request(testApp.app.getHttpServer())
        .post(path)
        .set('Cookie', staff())
        .set('x-region', 'eg')
        .send({ agentId: 22 })
        .expect(403);
    });

    it('Zone 4 - rejects assignment when the order is not ready', async () => {
      await markOnline(22);
      const order = await seedOrder(testApp.database, { status: 'placed' });
      await request(testApp.app.getHttpServer())
        .post(`/api/orders/${order.public_id}/assign`)
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .send({ agentId: 22 })
        .expect(400);
    });
  });

  describe('POST /api/orders/:publicId/reassign', () => {
    it('Zone 1 - clears the current assignment and selects another online agent', async () => {
      await markOnline(22, 30.0444, 31.2357);
      await markOnline(23, 30.045, 31.236);
      const order = await seedOrder(testApp.database, {
        status: 'assigned',
        delivery_agent_id: 22,
        assigned_at: new Date(),
        last_assignment_at: new Date(),
      });

      const response = await request(testApp.app.getHttpServer())
        .post(`/api/orders/${order.public_id}/reassign`)
        .set('Cookie', admin())
        .set('x-region', 'eg');

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ ok: true, assigned: true });
      await expect(
        testApp.database('orders').where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'assigned', delivery_agent_id: '23' });
    });

    it('Zone 2 - rejects a malformed order UUID', async () => {
      await request(testApp.app.getHttpServer())
        .post('/api/orders/not-a-uuid/reassign')
        .set('Cookie', admin())
        .set('x-region', 'eg')
        .expect(400);
    });

    it('Zone 3 - rejects no token and actors without assignment permission', async () => {
      const order = await seedOrder(testApp.database, { status: 'ready' });
      const path = `/api/orders/${order.public_id}/reassign`;
      await request(testApp.app.getHttpServer())
        .post(path)
        .set('x-region', 'eg')
        .expect(401);
      await request(testApp.app.getHttpServer())
        .post(path)
        .set('Cookie', customer())
        .set('x-region', 'eg')
        .expect(403);
      await request(testApp.app.getHttpServer())
        .post(path)
        .set('Cookie', staff())
        .set('x-region', 'eg')
        .expect(403);
    });

    it('Zone 4 - leaves the order ready when no replacement candidate exists', async () => {
      const order = await seedOrder(testApp.database, {
        status: 'assigned',
        delivery_agent_id: 22,
        assigned_at: new Date(),
      });
      const response = await request(testApp.app.getHttpServer())
        .post(`/api/orders/${order.public_id}/reassign`)
        .set('Cookie', admin())
        .set('x-region', 'eg');

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ ok: true, assigned: false });
      await expect(
        testApp.database('orders').where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: 'ready', delivery_agent_id: null });
    });
  });
});
