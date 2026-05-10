import { Logger } from '@nestjs/common';
import type { ICacheProvider } from '../../../pkg/cache/cache.interface';
import { cacheKeys } from '../../cache/cache-keys';
import { CoreEventHandler } from '../types';
import { BranchUpdatedPayload } from './handlers.types';

const logger = new Logger('BranchUpdatedHandler');

export function createBranchUpdatedHandler(
  cache: ICacheProvider,
): CoreEventHandler {
  return async (payload: unknown): Promise<void> => {
    const p = payload as BranchUpdatedPayload | null;
    if (!p?.branchId) {
      logger.warn(`malformed payload, skipping: ${JSON.stringify(payload)}`);
      return;
    }
    await cache.del(cacheKeys.branch(p.branchId));
  };
}
