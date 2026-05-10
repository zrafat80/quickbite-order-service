/**
 * Inbound payload shapes for core-event handlers. Mirrors what core-service
 * emits via its outbox (see core-service/.../events/event-types.ts and the
 * `insertOutboxEvent(s)` callers). Only the fields the handler actually
 * dispatches on are required.
 */

export interface ProductStockChangedPayload {
  branchId: number | string;
  productId: number | string;
}

export interface ProductPriceChangedPayload {
  branchId: number | string;
  productId: number | string;
}

export interface BranchUpdatedPayload {
  branchId: number | string;
}

export interface BranchDeactivatedPayload {
  branchId: number | string;
}

export interface RestaurantSuspendedPayload {
  restaurantId: number | string;
}

export interface RbacPermissionsChangedPayload {
  role?: string;
  roleName?: string;
}
