import { Global, Module } from '@nestjs/common';
import { RegionResolverMiddleware } from './region-resolver.middleware';

/**
 * Holds the X-Region resolver middleware. The middleware itself is applied
 * globally in `app.module.ts` via `MiddlewareConsumer`; this module just makes
 * the @Injectable() class available for DI.
 *
 * Region helpers (`isRegion`, `assertRegion`) are pure functions — no provider
 * needed.
 */
@Global()
@Module({
  providers: [RegionResolverMiddleware],
  exports: [RegionResolverMiddleware],
})
export class ShardingModule {}
