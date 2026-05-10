import { Logger } from '@nestjs/common';
import type { ICacheProvider } from '../../../pkg/cache/cache.interface';
import { cacheKeys } from '../../cache/cache-keys';
import { CoreEventHandler } from '../types';
import { RestaurantSuspendedPayload } from './handlers.types';

const logger = new Logger('RestaurantSuspendedHandler');

export function createRestaurantSuspendedHandler(
  cache: ICacheProvider,
): CoreEventHandler {
  return async (payload: unknown): Promise<void> => {
    const p = payload as RestaurantSuspendedPayload | null;
    if (!p?.restaurantId) {
      logger.warn(`malformed payload, skipping: ${JSON.stringify(payload)}`);
      return;
    }
    await cache.del(cacheKeys.restaurant(p.restaurantId));
  };
}
