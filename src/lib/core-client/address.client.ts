import { Inject, Injectable, Logger } from '@nestjs/common';
import { CoreHttpClient } from './core.http-client';
import { CoreCustomerAddress } from './address.client.types';
import { REDIS_CACHE_PROVIDER } from '../cache/redis.module';
import type { ICacheProvider } from '../../pkg/cache/cache.interface';
import { CACHE_TTL_SECONDS, cacheKeys } from '../cache/cache-keys';

@Injectable()
export class AddressClient {
  private readonly logger = new Logger(AddressClient.name);

  constructor(
    private readonly http: CoreHttpClient,
    @Inject(REDIS_CACHE_PROVIDER) private readonly cache: ICacheProvider,
  ) {}

  async getCustomerAddress(addressId: number): Promise<CoreCustomerAddress> {
    const key = cacheKeys.address(addressId);
    const cached = await this.safeGet(key);
    if (cached) return JSON.parse(cached) as CoreCustomerAddress;

    const res = await this.http.request<{ data: CoreCustomerAddress }>({
      method: 'GET',
      path: `/api/internal/customer-addresses/${addressId}`,
    });
    await this.safeSet(key, JSON.stringify(res.data), CACHE_TTL_SECONDS.ADDRESS);
    return res.data;
  }

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
