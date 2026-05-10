import { Global, Module } from '@nestjs/common';
import { CoreEventsConsumer } from './core-events.consumer';
import { HandlerRegistryService } from './handler-registry.service';

/**
 * Exports `HandlerRegistryService` so feature modules in later phases can
 * inject it from their own `OnModuleInit` and register cache-invalidation
 * handlers (e.g. `product.stock.changed` → invalidate `core:product:*`).
 *
 * The consumer itself starts in its own `OnModuleInit` and runs forever.
 */
@Global()
@Module({
  providers: [HandlerRegistryService, CoreEventsConsumer],
  exports: [HandlerRegistryService],
})
export class CoreEventsModule {}
