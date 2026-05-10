/**
 * Canonical Redis key builders for cross-service projections of core data.
 * The handler files in lib/core-events/handlers/ MUST use these same builders
 * to invalidate. New cached projections add a builder here first.
 */

const CORE = 'core';

export const cacheKeys = {
  branch: (branchId: number | string): string => `${CORE}:branch:${branchId}`,
  product: (branchId: number | string, productId: number | string): string =>
    `${CORE}:product:${branchId}:${productId}`,
  address: (addressId: number | string): string => `${CORE}:address:${addressId}`,
  restaurant: (restaurantId: number | string): string =>
    `${CORE}:restaurant:${restaurantId}`,
  rbacRole: (roleName: string): string => `${CORE}:rbac:perms:${roleName}`,
  branchRejectingNew: (branchId: number | string): string =>
    `${CORE}:branch:${branchId}:reject_orders`,
} as const;

export const CACHE_TTL_SECONDS = {
  BRANCH: 60 * 60, // 1 hour — metadata rarely changes; events invalidate
  PRODUCT: 5 * 60, // 5 min — stock churns; events invalidate; reserveStock is source of truth
  ADDRESS: 5 * 60, // 5 min — no event channel for addresses; rely on TTL
  RESTAURANT: 60 * 60, // 1 hour — events invalidate
} as const;
