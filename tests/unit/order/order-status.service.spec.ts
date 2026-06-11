import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OrderStatus } from "src/app/order/enums";
import { OrderStatusService } from "src/app/order/order-status.service";

describe("OrderStatusService", () => {
  const service = new OrderStatusService();

  it("allows valid restaurant transitions with permission", () => {
    expect(
      service.assertTransition(OrderStatus.PLACED, OrderStatus.ACCEPTED, {
        kind: "restaurant",
        userId: 7,
        restaurantId: 5,
        permissions: new Set(["orders:accept"]),
      }),
    ).toEqual({ timestampColumn: "accepted_at" });
  });

  it("allows customer cancellation and delivery transitions", () => {
    expect(
      service.assertTransition(OrderStatus.PLACED, OrderStatus.CANCELLED, {
        kind: "customer",
        userId: 7,
      }),
    ).toEqual({ timestampColumn: "cancelled_at" });
    expect(
      service.assertTransition(OrderStatus.ASSIGNED, OrderStatus.PICKED, {
        kind: "agent",
        userId: 9,
      }),
    ).toEqual({ timestampColumn: "picked_at" });
    expect(
      service.assertTransition(OrderStatus.PICKED, OrderStatus.DELIVERED, {
        kind: "agent",
        userId: 9,
      }),
    ).toEqual({ timestampColumn: "delivered_at" });
  });

  it("rejects unknown transitions as conflicts", () => {
    expect(() =>
      service.assertTransition(OrderStatus.DELIVERED, OrderStatus.PLACED, {
        kind: "system",
      }),
    ).toThrow(ConflictException);
  });

  it("rejects unauthorized actors and missing permissions as forbidden", () => {
    expect(() =>
      service.assertTransition(OrderStatus.PLACED, OrderStatus.ACCEPTED, {
        kind: "customer",
        userId: 7,
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      service.assertTransition(OrderStatus.PLACED, OrderStatus.ACCEPTED, {
        kind: "restaurant",
        userId: 7,
        restaurantId: 5,
        permissions: new Set(),
      }),
    ).toThrow(ForbiddenException);
  });
});
