import request from "supertest";
import { randomUUID } from "crypto";
import { seedOrder, seedOrderItem } from "../helpers/fixtures";
import { useOrderIntegrationApp } from "../helpers/test-app";

describe("Order merged E2E/integration", () => {
  const testApp = useOrderIntegrationApp();
  const customer = () =>
    testApp.authCookie({
      userId: 7,
      role: "customer",
      email: "customer@example.com",
    });
  const otherCustomer = () =>
    testApp.authCookie({
      userId: 8,
      role: "customer",
      email: "other@example.com",
    });
  const owner = (branchIds: number[] = [2]) =>
    testApp.authCookie({
      userId: 4,
      role: "restaurant_user",
      email: "owner@example.com",
      restaurantId: 3,
      restaurantRole: "owner",
      branchIds,
    });
  const foreignOwner = () =>
    testApp.authCookie({
      userId: 9,
      role: "restaurant_user",
      email: "foreign-owner@example.com",
      restaurantId: 4,
      restaurantRole: "owner",
      branchIds: [2],
    });
  const manager = (branchIds: number[] = [2]) =>
    testApp.authCookie({
      userId: 5,
      role: "restaurant_user",
      email: "manager@example.com",
      restaurantId: 3,
      restaurantRole: "branch_manager",
      branchIds,
    });
  const staff = (branchIds: number[] = [2]) =>
    testApp.authCookie({
      userId: 6,
      role: "restaurant_user",
      email: "staff@example.com",
      restaurantId: 3,
      restaurantRole: "staff",
      branchIds,
    });
  const orderPayload = {
    branchId: 2,
    customerAddressId: 9,
    paymentMethod: "cod",
    items: [{ productId: 12, quantity: 2 }],
  };

  describe("POST /api/orders", () => {
    it("Zone 1 - creates the order, items, outbox event, and reserves stock", async () => {
      const response = await request(testApp.app.getHttpServer())
        .post("/api/orders")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .set("Idempotency-Key", "order-create-1")
        .send(orderPayload);

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        status: "placed",
        branchId: 2,
        customerId: 7,
        money: {
          subtotal: 1000,
          deliveryFee: 100,
          total: 1100,
          currency: "EGP",
        },
        items: [{ productId: 12, quantity: 2, lineTotal: 1000 }],
      });

      const order = await testApp.database("orders").first();
      expect(order).toMatchObject({
        customer_id: "7",
        branch_id: "2",
        status: "placed",
        total: 1100,
      });
      await expect(
        testApp.database("order_items").where({ order_id: order.id }).first(),
      ).resolves.toMatchObject({ product_id: "12", quantity: 2 });
      await expect(
        testApp
          .database("events_outbox")
          .where({ aggregate_id: order.public_id })
          .first(),
      ).resolves.toMatchObject({ event_type: "order.placed" });
      expect(testApp.external.products.get(2)!.get(12)!.stock).toBe(18);
    });

    it("Zone 2 - rejects missing, negative, and empty DTO values with 400", async () => {
      const response = await request(testApp.app.getHttpServer())
        .post("/api/orders")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .set("Idempotency-Key", "order-invalid-1")
        .send({
          branchId: -1,
          customerAddressId: "wrong",
          paymentMethod: "cash",
          items: [],
        });

      expect(response.status).toBe(400);
      expect(await testApp.database("orders")).toHaveLength(0);
    });

    it("Zone 3 - enforces authentication, customer role, and address ownership", async () => {
      await request(testApp.app.getHttpServer())
        .post("/api/orders")
        .set("x-region", "eg")
        .set("Idempotency-Key", "order-no-auth")
        .send(orderPayload)
        .expect(401);

      await request(testApp.app.getHttpServer())
        .post("/api/orders")
        .set("Cookie", owner())
        .set("x-region", "eg")
        .set("Idempotency-Key", "order-wrong-role")
        .send(orderPayload)
        .expect(403);

      await request(testApp.app.getHttpServer())
        .post("/api/orders")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .set("Idempotency-Key", "order-cross-tenant")
        .send({ ...orderPayload, customerAddressId: 10 })
        .expect(403);

      expect(await testApp.database("orders")).toHaveLength(0);
    });

    it("Zone 4 - rejects inactive branches and conflicting idempotency replays", async () => {
      testApp.external.branches.get(2)!.acceptOrders = false;
      await request(testApp.app.getHttpServer())
        .post("/api/orders")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .set("Idempotency-Key", "order-inactive")
        .send(orderPayload)
        .expect(409);

      testApp.external.branches.get(2)!.acceptOrders = true;
      testApp.cacheProvider.reset();
      await request(testApp.app.getHttpServer())
        .post("/api/orders")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .set("Idempotency-Key", "order-replay")
        .send(orderPayload)
        .expect(201);

      await request(testApp.app.getHttpServer())
        .post("/api/orders")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .set("Idempotency-Key", "order-replay")
        .send({
          ...orderPayload,
          items: [{ productId: 12, quantity: 1 }],
        })
        .expect(409);

      expect(await testApp.database("orders")).toHaveLength(1);
    });
  });

  describe("GET /api/orders/:publicId", () => {
    it("Zone 1 - reads the persisted order and its items", async () => {
      const order = await seedOrder(testApp.database);
      await seedOrderItem(testApp.database, order);

      const response = await request(testApp.app.getHttpServer())
        .get(`/api/orders/${order.public_id}`)
        .set("Cookie", customer())
        .set("x-region", "eg");

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: order.public_id,
        customerId: 7,
        items: [{ productId: 12, quantity: 2 }],
      });
    });

    it("Zone 2 - rejects a malformed UUID with 400", async () => {
      await request(testApp.app.getHttpServer())
        .get("/api/orders/not-a-uuid")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .expect(400);
    });

    it("Zone 3 - rejects missing auth and cross-customer reads", async () => {
      const order = await seedOrder(testApp.database);

      await request(testApp.app.getHttpServer())
        .get(`/api/orders/${order.public_id}`)
        .set("x-region", "eg")
        .expect(401);

      await request(testApp.app.getHttpServer())
        .get(`/api/orders/${order.public_id}`)
        .set("Cookie", otherCustomer())
        .set("x-region", "eg")
        .expect(403);
    });

    it("Zone 4 - returns 404 for a valid but unknown order", async () => {
      await request(testApp.app.getHttpServer())
        .get(`/api/orders/${randomUUID()}`)
        .set("Cookie", customer())
        .set("x-region", "eg")
        .expect(404);
    });
  });

  describe("PATCH /api/orders/:publicId/status", () => {
    it("Zone 1 - advances an owned restaurant order and commits its timestamp", async () => {
      const order = await seedOrder(testApp.database);

      const response = await request(testApp.app.getHttpServer())
        .patch(`/api/orders/${order.public_id}/status`)
        .set("Cookie", owner())
        .set("x-region", "eg")
        .send({ status: "accepted" });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: order.public_id,
        status: "accepted",
      });
      await expect(
        testApp.database("orders").where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: "accepted" });

      const managerOrder = await seedOrder(testApp.database, {
        public_id: randomUUID(),
      });
      await request(testApp.app.getHttpServer())
        .patch(`/api/orders/${managerOrder.public_id}/status`)
        .set("Cookie", manager())
        .set("x-region", "eg")
        .send({ status: "accepted" })
        .expect(200);
      await expect(
        testApp.database("orders").where({ id: managerOrder.id }).first(),
      ).resolves.toMatchObject({ status: "accepted" });
    });

    it("Zone 2 - rejects malformed UUIDs and invalid status values", async () => {
      await request(testApp.app.getHttpServer())
        .patch("/api/orders/not-a-uuid/status")
        .set("Cookie", owner())
        .set("x-region", "eg")
        .send({ status: "accepted" })
        .expect(400);

      const order = await seedOrder(testApp.database);
      await request(testApp.app.getHttpServer())
        .patch(`/api/orders/${order.public_id}/status`)
        .set("Cookie", owner())
        .set("x-region", "eg")
        .send({ status: "unknown" })
        .expect(400);
    });

    it("Zone 3 - rejects missing auth, cross-tenant access, staff, and an unassigned branch manager", async () => {
      const order = await seedOrder(testApp.database);
      const url = `/api/orders/${order.public_id}/status`;

      await request(testApp.app.getHttpServer())
        .patch(url)
        .set("x-region", "eg")
        .send({ status: "accepted" })
        .expect(401);

      await request(testApp.app.getHttpServer())
        .patch(url)
        .set("Cookie", otherCustomer())
        .set("x-region", "eg")
        .send({ status: "cancelled" })
        .expect(403);

      await request(testApp.app.getHttpServer())
        .patch(url)
        .set("Cookie", foreignOwner())
        .set("x-region", "eg")
        .send({ status: "accepted" })
        .expect(403);

      await request(testApp.app.getHttpServer())
        .patch(url)
        .set("Cookie", staff())
        .set("x-region", "eg")
        .send({ status: "accepted" })
        .expect(403);

      await request(testApp.app.getHttpServer())
        .patch(url)
        .set("Cookie", manager([]))
        .set("x-region", "eg")
        .send({ status: "accepted" })
        .expect(403);

      await expect(
        testApp.database("orders").where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: "placed" });
    });

    it("Zone 4 - rejects an invalid status transition without changing the row", async () => {
      const order = await seedOrder(testApp.database, { status: "placed" });

      await request(testApp.app.getHttpServer())
        .patch(`/api/orders/${order.public_id}/status`)
        .set("Cookie", owner())
        .set("x-region", "eg")
        .send({ status: "ready" })
        .expect(409);

      await expect(
        testApp.database("orders").where({ id: order.id }).first(),
      ).resolves.toMatchObject({ status: "placed" });
    });
  });

  describe("GET /api/customer/orders", () => {
    it("Zone 1 - lists persisted orders for the authenticated customer", async () => {
      const order = await seedOrder(testApp.database);
      await seedOrderItem(testApp.database, order);

      const response = await request(testApp.app.getHttpServer())
        .get("/api/customer/orders?year=2026&status=placed")
        .set("Cookie", customer())
        .set("x-region", "eg");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([
        expect.objectContaining({ id: order.public_id, itemCount: 1 }),
      ]);
    });

    it("Zone 2 - rejects invalid year and status filters", async () => {
      await request(testApp.app.getHttpServer())
        .get("/api/customer/orders?year=bad")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .expect(400);

      await request(testApp.app.getHttpServer())
        .get("/api/customer/orders?status=unknown")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .expect(400);
    });

    it("Zone 3 - rejects missing auth and non-customer roles", async () => {
      await request(testApp.app.getHttpServer())
        .get("/api/customer/orders")
        .set("x-region", "eg")
        .expect(401);

      await request(testApp.app.getHttpServer())
        .get("/api/customer/orders")
        .set("Cookie", owner())
        .set("x-region", "eg")
        .expect(403);
    });

    it("Zone 4 - isolates one customer from another customer’s rows", async () => {
      const own = await seedOrder(testApp.database, { customer_id: 7 });
      await seedOrder(testApp.database, {
        public_id: randomUUID(),
        customer_id: 8,
        created_at: new Date("2026-05-02T10:00:00.000Z"),
        updated_at: new Date("2026-05-02T10:00:00.000Z"),
      });

      const response = await request(testApp.app.getHttpServer())
        .get("/api/customer/orders")
        .set("Cookie", customer())
        .set("x-region", "eg");

      const ids = response.body.data.map((row: any) => row.id);
      expect(ids).toEqual([own.public_id]);
    });
  });

  describe("GET /api/restaurant/orders", () => {
    it("Zone 1 - lists branch orders through real permission and branch guards", async () => {
      const order = await seedOrder(testApp.database);
      await seedOrderItem(testApp.database, order);

      const response = await request(testApp.app.getHttpServer())
        .get("/api/restaurant/orders?branchId=2")
        .set("Cookie", owner())
        .set("x-region", "eg");

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([
        expect.objectContaining({ id: order.public_id, branchId: 2 }),
      ]);
    });

    it("Zone 2 - rejects missing branchId and invalid status filters", async () => {
      await request(testApp.app.getHttpServer())
        .get("/api/restaurant/orders")
        .set("Cookie", owner())
        .set("x-region", "eg")
        .expect(400);

      await request(testApp.app.getHttpServer())
        .get("/api/restaurant/orders?branchId=2&status=unknown")
        .set("Cookie", owner())
        .set("x-region", "eg")
        .expect(400);
    });

    it("Zone 3 - rejects no token, wrong role, and a scoped foreign branch", async () => {
      await request(testApp.app.getHttpServer())
        .get("/api/restaurant/orders?branchId=2")
        .set("x-region", "eg")
        .expect(401);

      await request(testApp.app.getHttpServer())
        .get("/api/restaurant/orders?branchId=2")
        .set("Cookie", customer())
        .set("x-region", "eg")
        .expect(403);

      await request(testApp.app.getHttpServer())
        .get("/api/restaurant/orders?branchId=2")
        .set("Cookie", manager([99]))
        .set("x-region", "eg")
        .expect(403);
    });

    it("Zone 4 - never returns orders belonging to another branch", async () => {
      const own = await seedOrder(testApp.database, { branch_id: 2 });
      await seedOrder(testApp.database, {
        public_id: randomUUID(),
        branch_id: 99,
        created_at: new Date("2026-05-02T10:00:00.000Z"),
        updated_at: new Date("2026-05-02T10:00:00.000Z"),
      });

      const response = await request(testApp.app.getHttpServer())
        .get("/api/restaurant/orders?branchId=2")
        .set("Cookie", owner())
        .set("x-region", "eg");

      const ids = response.body.data.map((row: any) => row.id);
      expect(ids).toEqual([own.public_id]);
    });
  });
});
