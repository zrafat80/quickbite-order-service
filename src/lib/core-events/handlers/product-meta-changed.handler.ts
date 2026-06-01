import { Logger } from '@nestjs/common';
import type { ICacheProvider } from '../../../pkg/cache/cache.interface';
import { cacheKeys } from '../../cache/cache-keys';
import { CoreEventHandler } from '../types';
import { ProductMetaChangedPayload } from './handlers.types';

const logger = new Logger('ProductMetaChangedHandler');

/**
 * Fires when an admin updates name / image / availability on a product.
 * (Price changes are emitted as the separate `product.price.changed` event
 * — both invalidate the meta projection, but they're kept distinct in case
 * analytics or other consumers care about the cause.)
 */
export function createProductMetaChangedHandler(
  cache: ICacheProvider,
): CoreEventHandler {
  return async (payload: unknown): Promise<void> => {
    const p = payload as ProductMetaChangedPayload | null;
    if (!p?.branchId || !p?.productId) {
      logger.warn(`malformed payload, skipping: ${JSON.stringify(payload)}`);
      return;
    }
    await cache.del(cacheKeys.productMeta(p.branchId, p.productId));
  };
}
