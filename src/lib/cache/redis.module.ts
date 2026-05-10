import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisCacheProvider } from '../../pkg/cache/redis';

export const REDIS_CLIENT = 'REDIS_CLIENT';
export const REDIS_CACHE_PROVIDER = 'REDIS_CACHE_PROVIDER';

const redisClientProvider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('RedisClient');
    const client = new Redis({
      host: configService.get<string>('redis.host') ?? 'localhost',
      port: configService.get<number>('redis.port') ?? 6379,
      password: configService.get<string>('redis.password') || undefined,
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });

    client.on('error', (err) => {
      logger.error(`Redis error: ${err.message}`);
    });
    client.on('connect', () => logger.log('Redis connected'));
    client.on('reconnecting', () => logger.warn('Redis reconnecting…'));

    return client;
  },
};

const redisCacheProviderProvider = {
  provide: REDIS_CACHE_PROVIDER,
  inject: [REDIS_CLIENT],
  useFactory: (client: Redis) => new RedisCacheProvider(client),
};

@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisLifecycle.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`Closing Redis client (${signal ?? 'shutdown'})…`);
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

/**
 * One shared ioredis instance reused by:
 *   - the core-events consumer's SETNX dedupe
 *   - the websocket gateway's @socket.io/redis-adapter (+ a duplicate() for sub)
 *   - any future SETNX / Pub-Sub need
 *
 * `@nestjs/cache-manager` (UnifiedCacheInterceptor + IdempotencyInterceptor)
 * uses its own connection through `@keyv/redis` configured in app.module.ts.
 * Splitting them keeps cache-manager's keyv namespacing intact.
 */
@Global()
@Module({
  providers: [redisClientProvider, redisCacheProviderProvider, RedisLifecycle],
  exports: [REDIS_CLIENT, REDIS_CACHE_PROVIDER],
})
export class RedisModule {}
