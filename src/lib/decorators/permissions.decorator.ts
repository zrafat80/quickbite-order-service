import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Tag a route with the permission required to invoke it. Consumed by
 * `PermissionsGuard` (which lands in Phase 1 alongside the permission cache).
 *
 *   @RequirePermissions('orders', 'accept')
 */
export const RequirePermissions = (
  resource: string,
  action: string,
  allowSystemAdmin = true,
) => SetMetadata(PERMISSIONS_KEY, { resource, action, allowSystemAdmin });
