import { Injectable } from '@nestjs/common';
import { CoreHttpClient } from './core.http-client';

/**
 * Reads role permissions from core-service. Used by `PermissionCacheService`
 * to feed `PermissionsGuard`. The endpoint returns the canonical "resource:action"
 * list for the named role (e.g. "owner", "branch_manager", "staff").
 */
@Injectable()
export class PermissionClient {
  constructor(private readonly http: CoreHttpClient) {}

  async getRolePermissions(roleName: string): Promise<string[]> {
    const res = await this.http.request<{
      data: { role: string; permissions: string[] };
    }>({
      method: 'GET',
      path: `/api/roles/${encodeURIComponent(roleName)}/permissions`,
    });
    const perms = res?.data?.permissions;
    return Array.isArray(perms) ? perms : [];
  }
}
