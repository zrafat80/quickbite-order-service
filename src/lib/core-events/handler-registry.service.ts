import { Injectable, Logger } from '@nestjs/common';
import { CoreEventHandler } from './types';

/**
 * Registry of `eventType -> handler`. Modules in later phases register their
 * cache-invalidation handlers from `OnModuleInit`. Phase 0 ships the registry
 * empty; the consumer logs unknown event types and acks them (NOT routed to
 * DLQ — unknown != poison).
 */
@Injectable()
export class HandlerRegistryService {
  private readonly logger = new Logger(HandlerRegistryService.name);
  private readonly handlers = new Map<string, CoreEventHandler>();

  register(eventType: string, handler: CoreEventHandler): void {
    if (this.handlers.has(eventType)) {
      throw new Error(`Handler already registered for ${eventType}`);
    }
    this.handlers.set(eventType, handler);
    this.logger.log(`registered handler for "${eventType}"`);
  }

  get(eventType: string): CoreEventHandler | undefined {
    return this.handlers.get(eventType);
  }

  list(): string[] {
    return Array.from(this.handlers.keys());
  }
}
