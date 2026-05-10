import { Inject, Injectable, Logger } from '@nestjs/common';
import { CoreHttpClient } from './core.http-client';
import {
  BranchStockItem,
  CoreBranchMetadata,
  CoreBranchProduct,
  ReleaseStockResult,
  ReserveStockResult,
} from './branch.client.types';
import { REDIS_CACHE_PROVIDER } from '../cache/redis.module';
import type { ICacheProvider } from '../../pkg/cache/cache.interface';
import { CACHE_TTL_SECONDS, cacheKeys } from '../cache/cache-keys';

/**
 * Calls /api/internal/branches/* on core-service. The CoreHttpClient sets
 * `x-api-key` automatically and translates non-2xx into NestJS exceptions.
 *
 * The SuccessInterceptor on core wraps responses in `{isSuccess, data, ...}`,
 * so we unwrap `.data` after fetching. CoreHttpClient returns raw JSON.
 *
 * Read methods (`getBranch`, `getBranchProducts`) are read-through against
 * Redis. Cache invalidation happens via core-event handlers in
 * `lib/core-events/handlers/*`. Write methods (`reserveStock`,
 * `releaseStock`) bypass the cache by design — they're the source of truth.
 */
@Injectable()
export class BranchClient {
  private readonly logger = new Logger(BranchClient.name);

  constructor(
    private readonly http: CoreHttpClient,
    @Inject(REDIS_CACHE_PROVIDER) private readonly cache: ICacheProvider,
  ) {}

  async getBranch(branchId: number): Promise<CoreBranchMetadata> {
    const key = cacheKeys.branch(branchId);
    const cached = await this.safeGet(key);
    if (cached) return JSON.parse(cached) as CoreBranchMetadata;

    const res = await this.http.request<{ data: CoreBranchMetadata }>({
      method: 'GET',
      path: `/api/internal/branches/${branchId}`,
    });
    await this.safeSet(key, JSON.stringify(res.data), CACHE_TTL_SECONDS.BRANCH);
    return res.data;
  }

  async getBranchProducts(
    branchId: number,
    productIds: number[],
  ): Promise<CoreBranchProduct[]> {
    if (productIds.length === 0) return [];

    const cachedById = new Map<number, CoreBranchProduct>();
    await Promise.all(
      productIds.map(async (id) => {
        const raw = await this.safeGet(cacheKeys.product(branchId, id));
        if (raw) cachedById.set(id, JSON.parse(raw) as CoreBranchProduct);
      }),
    );

    const missingIds = productIds.filter((id) => !cachedById.has(id));
    if (missingIds.length > 0) {
      const res = await this.http.request<{ data: CoreBranchProduct[] }>({
        method: 'GET',
        path: `/api/internal/branches/${branchId}/products`,
        query: { ids: missingIds.join(',') },
      });
      for (const p of res.data ?? []) {
        cachedById.set(p.productId, p);
        await this.safeSet(
          cacheKeys.product(branchId, p.productId),
          JSON.stringify(p),
          CACHE_TTL_SECONDS.PRODUCT,
        );
      }
    }

    const out: CoreBranchProduct[] = [];
    for (const id of productIds) {
      const p = cachedById.get(id);
      if (p) out.push(p);
    }
    return out;
  }

  async reserveStock(
    branchId: number,
    items: BranchStockItem[],
    idempotencyKey: string,
  ): Promise<ReserveStockResult> {
    const res = await this.http.request<{ data: ReserveStockResult }>({
      method: 'POST',
      path: `/api/internal/branches/${branchId}/reserve-stock`,
      body: { items },
      idempotencyKey,
    });
    return res.data;
  }

  async releaseStock(
    branchId: number,
    items: BranchStockItem[],
    idempotencyKey: string,
  ): Promise<ReleaseStockResult> {
    const res = await this.http.request<{ data: ReleaseStockResult }>({
      method: 'POST',
      path: `/api/internal/branches/${branchId}/release-stock`,
      body: { items },
      idempotencyKey,
    });
    return res.data;
  }

  // Cache faults must never break a real request — degrade to direct HTTP.
  private async safeGet(key: string): Promise<string | null> {
    try {
      return await this.cache.get(key);
    } catch (err) {
      this.logger.warn(`cache get failed (${key}): ${(err as Error).message}`);
      return null;
    }
  }

  private async safeSet(key: string, value: string, ttl: number): Promise<void> {
    try {
      await this.cache.set(key, value, ttl);
    } catch (err) {
      this.logger.warn(`cache set failed (${key}): ${(err as Error).message}`);
    }
  }
}
