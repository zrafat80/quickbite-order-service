import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  CACHE_MANAGER,
  CACHE_TTL_METADATA,
  CacheInterceptor,
} from '@nestjs/cache-manager';
import { Reflector } from '@nestjs/core';
import { Observable, finalize, of, share, tap } from 'rxjs';

/**
 * Redis-backed response cache with stampede protection.
 *
 * Order-service deviation: cache keys are namespaced by `req.region` so two
 * customers in different shards can never collide on the same cached payload.
 */
@Injectable()
export class UnifiedCacheInterceptor extends CacheInterceptor {
  private readonly inFlightRequests = new Map<string, Observable<any>>();

  constructor(
    @Inject(CACHE_MANAGER) cacheManager: any,
    protected readonly reflector: Reflector,
  ) {
    super(cacheManager, reflector);
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    if (request.method !== 'GET') return next.handle();

    const scope =
      this.reflector.get<'PUBLIC' | 'PRIVATE'>(
        'cache_scope',
        context.getHandler(),
      ) || 'PUBLIC';

    const region = request.region || 'noregion';
    let key = `${region}:${request.method}:${request.url}`;

    if (scope === 'PRIVATE') {
      if (!request.user || !request.user.userId) return next.handle();
      key = `${key}:${request.user.userId}`;
    }

    try {
      const cachedValue = await this.cacheManager.get(key);
      if (cachedValue) {
        response.setHeader('X-Cache', `HIT (${scope})`);
        return of(cachedValue);
      }

      const activeStream = this.inFlightRequests.get(key);
      if (activeStream) {
        response.setHeader('X-Cache', `DEDUPLICATED (${scope})`);
        return activeStream;
      }

      response.setHeader('X-Cache', `MISS (${scope})`);
      const customTtl = this.reflector.get<number>(
        CACHE_TTL_METADATA,
        context.getHandler(),
      );

      const dbStream = next.handle().pipe(
        tap((data) => {
          this.cacheManager
            .set(key, data, customTtl)
            // eslint-disable-next-line no-console
            .catch((err: any) => console.error('Redis Save Error:', err));
        }),
        finalize(() => this.inFlightRequests.delete(key)),
        share(),
      );

      this.inFlightRequests.set(key, dbStream);
      return dbStream;
    } catch {
      return next.handle();
    }
  }
}
