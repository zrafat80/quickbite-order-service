import { Injectable } from '@nestjs/common';
import { PermissionClient } from '../../core-client/permission.client';
import { toMs } from '../../../pkg/utils/time.utils';

/**
 * Per-process in-memory cache of role → permissions, refreshed via the
 * core-client. TTL keeps it cheap; the `rbac.permissions_changed` core
 * event handler will eventually invalidate via `clear()` (Phase 1+).
 *
 * Same shape as core's `PermissionCacheService` so the surrounding code
 * pattern is interchangeable.
 */
@Injectable()
export class PermissionCacheService {
  private readonly cache = new Map<
    string,
    { permissions: string[]; cachedAt: number }
  >();

  private readonly ttlMs = toMs(1, 'h');

  constructor(private readonly permissionClient: PermissionClient) {}

  async getPermissions(roleName: string): Promise<string[]> {
    const cached = this.cache.get(roleName);
    if (cached && Date.now() - cached.cachedAt < this.ttlMs) {
      return cached.permissions;
    }
    const permissions =
      await this.permissionClient.getRolePermissions(roleName);
    this.cache.set(roleName, { permissions, cachedAt: Date.now() });
    return permissions;
  }

  hasPermission(
    permissions: string[],
    resource: string,
    action: string,
  ): boolean {
    return permissions.includes(`${resource}:${action}`);
  }

  clear(roleName?: string): void {
    if (roleName) this.cache.delete(roleName);
    else this.cache.clear();
  }
}
