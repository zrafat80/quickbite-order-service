import { Global, Module } from '@nestjs/common';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionsGuard } from './permissions.guard';

/**
 * Global so any feature module can `@UseGuards(PermissionsGuard)` without
 * explicitly importing it. PermissionClient is supplied transitively via
 * CoreClientModule (also @Global()).
 */
@Global()
@Module({
  providers: [PermissionCacheService, PermissionsGuard],
  exports: [PermissionCacheService, PermissionsGuard],
})
export class PermissionsModule {}
