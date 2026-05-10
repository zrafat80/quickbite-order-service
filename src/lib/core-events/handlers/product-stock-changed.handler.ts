import { Logger } from '@nestjs/common';
import type { ICacheProvider } from '../../../pkg/cache/cache.interface';
import { cacheKeys } from '../../cache/cache-keys';
import { CoreEventHandler } from '../types';
import { ProductStockChangedPayload } from './handlers.types';

const logger = new Logger('ProductStockChangedHandler');

export function createProductStockChangedHandler(
  cache: ICacheProvider,
): CoreEventHandler {
  return async (payload: unknown): Promise<void> => {
    const p = payload as ProductStockChangedPayload | null;
    if (!p?.branchId || !p?.productId) {
      logger.warn(`malformed payload, skipping: ${JSON.stringify(payload)}`);
      return;
    }
    await cache.del(cacheKeys.product(p.branchId, p.productId));
  };
}
