import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import type { ICacheProvider } from '../../pkg/cache/cache.interface';
import { REDIS_CACHE_PROVIDER } from '../cache/redis.module';
import { PermissionCacheService } from '../middleware/guards/permission-cache.service';
import { HandlerRegistryService } from './handler-registry.service';
import { createBranchDeactivatedHandler } from './handlers/branch-deactivated.handler';
import { createBranchUpdatedHandler } from './handlers/branch-updated.handler';
import { createProductMetaChangedHandler } from './handlers/product-meta-changed.handler';
import { createProductPriceChangedHandler } from './handlers/product-price-changed.handler';
import { createProductStockChangedHandler } from './handlers/product-stock-changed.handler';
import { createRbacPermissionsChangedHandler } from './handlers/rbac-permissions-changed.handler';
import { createRestaurantSuspendedHandler } from './handlers/restaurant-suspended.handler';

/**
 * The full set of core-event types this service consumes for cache
 * invalidation. Bound from `core.events` via the topic exchange in
 * `CoreEventsConsumer`. Anything not in this map will be acked & logged
 * by the consumer (forward-compat — unknown != poison).
 */
const EVENT_TYPES = {
  PRODUCT_STOCK_CHANGED: 'product.stock.changed',
  PRODUCT_PRICE_CHANGED: 'product.price.changed',
  PRODUCT_META_CHANGED: 'product.meta.changed',
  BRANCH_UPDATED: 'branch.updated',
  BRANCH_DEACTIVATED: 'branch.deactivated',
  RESTAURANT_SUSPENDED: 'restaurant.suspended',
  RBAC_PERMISSIONS_CHANGED: 'rbac.permissions_changed',
} as const;

@Injectable()
class CacheInvalidationRegistrar implements OnModuleInit {
  private readonly logger = new Logger(CacheInvalidationRegistrar.name);

  constructor(
    private readonly registry: HandlerRegistryService,
    private readonly permissions: PermissionCacheService,
    @Inject(REDIS_CACHE_PROVIDER) private readonly cache: ICacheProvider,
  ) {}

  onModuleInit() {
    this.registry.register(
      EVENT_TYPES.PRODUCT_STOCK_CHANGED,
      createProductStockChangedHandler(this.cache),
    );
    this.registry.register(
      EVENT_TYPES.PRODUCT_PRICE_CHANGED,
      createProductPriceChangedHandler(this.cache),
    );
    this.registry.register(
      EVENT_TYPES.PRODUCT_META_CHANGED,
      createProductMetaChangedHandler(this.cache),
    );
    this.registry.register(
      EVENT_TYPES.BRANCH_UPDATED,
      createBranchUpdatedHandler(this.cache),
    );
    this.registry.register(
      EVENT_TYPES.BRANCH_DEACTIVATED,
      createBranchDeactivatedHandler(this.cache),
    );
    this.registry.register(
      EVENT_TYPES.RESTAURANT_SUSPENDED,
      createRestaurantSuspendedHandler(this.cache),
    );
    this.registry.register(
      EVENT_TYPES.RBAC_PERMISSIONS_CHANGED,
      createRbacPermissionsChangedHandler(this.permissions),
    );
    this.logger.log(
      `registered ${Object.keys(EVENT_TYPES).length} core-event handlers`,
    );
  }
}

@Module({
  providers: [CacheInvalidationRegistrar],
})
export class CacheInvalidationModule {}
