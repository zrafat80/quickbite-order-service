import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../../decorators/permissions.decorator';
import { GUARD_ERRORS } from './guard.constants';
import { PermissionCacheService } from './permission-cache.service';

/**
 * Mirrors core-service's PermissionsGuard. Reads `@RequirePermissions(resource, action)`
 * metadata, resolves the user's permissions via the read-through PermissionCacheService,
 * and 403s if the action is not granted.
 *
 * `system_admin` is allowed by default (controllable per route). Restaurant users have
 * their permission list looked up by `restaurantRole`. Customers and delivery agents do
 * not currently use `@RequirePermissions` paths — those routes lean on JwtAuthGuard +
 * resource-ownership checks in the service.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionCache: PermissionCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<{
      resource: string;
      action: string;
      allowSystemAdmin: boolean;
    }>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    if (!required) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) {
      throw new ForbiddenException(GUARD_ERRORS.UNAUTHENTICATED);
    }

    if (required.allowSystemAdmin && user.role === 'system_admin') return true;

    if (user.role === 'restaurant_user' && user.restaurantRole) {
      const permissions = await this.permissionCache.getPermissions(
        user.restaurantRole,
      );
      const ok = this.permissionCache.hasPermission(
        permissions,
        required.resource,
        required.action,
      );
      if (!ok) {
        throw new ForbiddenException(
          `Missing permission ${required.resource}:${required.action}`,
        );
      }
      return true;
    }

    throw new ForbiddenException(
      `Missing permission ${required.resource}:${required.action}`,
    );
  }
}
