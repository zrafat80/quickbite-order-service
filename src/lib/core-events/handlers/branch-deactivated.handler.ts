import { Logger } from '@nestjs/common';
import type { ICacheProvider } from '../../../pkg/cache/cache.interface';
import { cacheKeys } from '../../cache/cache-keys';
import { CoreEventHandler } from '../types';
import { BranchDeactivatedPayload } from './handlers.types';

const logger = new Logger('BranchDeactivatedHandler');

const REJECT_FLAG_TTL_SECONDS = 24 * 60 * 60;

/**
 * Beyond invalidating the branch projection we also raise a flag that
 * OrderService can read out-of-band to refuse new orders for the branch
 * before the next branch fetch hydrates the cache. CLAUDE.md §async-with-
 * core: "branch.deactivated additionally sets a Redis flag that the orders
 * service checks to reject new orders to that branch."
 */
export function createBranchDeactivatedHandler(
  cache: ICacheProvider,
): CoreEventHandler {
  return async (payload: unknown): Promise<void> => {
    const p = payload as BranchDeactivatedPayload | null;
    if (!p?.branchId) {
      logger.warn(`malformed payload, skipping: ${JSON.stringify(payload)}`);
      return;
    }
    await cache.del(cacheKeys.branch(p.branchId));
    await cache.set(
      cacheKeys.branchRejectingNew(p.branchId),
      '1',
      REJECT_FLAG_TTL_SECONDS,
    );
  };
}
