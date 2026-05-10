import { Logger } from '@nestjs/common';
import { PermissionCacheService } from '../../middleware/guards/permission-cache.service';
import { CoreEventHandler } from '../types';
import { RbacPermissionsChangedPayload } from './handlers.types';

const logger = new Logger('RbacPermissionsChangedHandler');

/**
 * Permissions live in `PermissionCacheService` (in-process Map, not Redis),
 * so we punch through the service's `clear(role?)` rather than deleting a
 * Redis key. If no role is provided we clear the whole cache so the next
 * permission check refreshes from core for every role.
 */
export function createRbacPermissionsChangedHandler(
  permissions: PermissionCacheService,
): CoreEventHandler {
  return async (payload: unknown): Promise<void> => {
    const p = payload as RbacPermissionsChangedPayload | null;
    const role = p?.role ?? p?.roleName;
    if (role) {
      permissions.clear(role);
    } else {
      logger.warn('payload missing role; clearing entire permission cache');
      permissions.clear();
    }
  };
}
