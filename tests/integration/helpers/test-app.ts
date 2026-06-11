import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { Knex } from 'knex';
import { AppModule } from 'src/app.module';
import { REDIS_CACHE_PROVIDER, REDIS_CLIENT } from 'src/lib/cache/redis.module';
import { PermissionCacheService } from 'src/lib/middleware/guards/permission-cache.service';
import { AmqpConnection } from 'src/lib/messaging/amqp.connection';
import { OrderEventsBroker } from 'src/lib/events/order-events.broker';
import { ShardedKnex } from 'src/lib/sharding/shards';
import { WsGateway } from 'src/lib/websocket/ws.gateway';
import {
  BoundaryAmqpConnection,
  BoundaryOrderEventsBroker,
  BoundaryWsGateway,
  ExternalBoundaryServer,
  MemoryCacheManager,
  MemoryCacheProvider,
  MemoryRedis,
} from './external-boundaries';
import {
  assertOrderTestDatabase,
  ensureOrderTestDatabase,
  truncateOrderTables,
} from './test-database';

export function useOrderIntegrationApp() {
  const cacheManager = new MemoryCacheManager();
  const cacheProvider = new MemoryCacheProvider();
  const redis = new MemoryRedis();
  const amqp = new BoundaryAmqpConnection();
  const orderEvents = new BoundaryOrderEventsBroker();
  const wsGateway = new BoundaryWsGateway();
  const external = new ExternalBoundaryServer();
  let app: INestApplication;
  let database: Knex;

  beforeAll(async () => {
    await ensureOrderTestDatabase();
    await external.start();
    process.env.CORE_SERVICE_BASE_URL = external.baseUrl;
    process.env.KASHIER_BASE_URL = external.baseUrl;
    process.env.KASHIER_FEP_URL = external.baseUrl;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CACHE_MANAGER)
      .useValue(cacheManager)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redis)
      .overrideProvider(REDIS_CACHE_PROVIDER)
      .useValue(cacheProvider)
      .overrideProvider(AmqpConnection)
      .useValue(amqp)
      .overrideProvider(OrderEventsBroker)
      .useValue(orderEvents)
      .overrideProvider(WsGateway)
      .useValue(wsGateway)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const sharded = app.get<ShardedKnex>('KNEX_CONNECTION');
    database = sharded.db('eg');
    assertOrderTestDatabase(database);
  });

  beforeEach(async () => {
    await truncateOrderTables(database);
    cacheManager.reset();
    cacheProvider.reset();
    redis.reset();
    orderEvents.reset();
    wsGateway.reset();
    external.reset();
    app.get(PermissionCacheService).clear();
  });

  afterAll(async () => {
    await app.close();
    await external.close();
  });

  return {
    get app() {
      return app;
    },
    get database() {
      return database;
    },
    external,
    cacheProvider,
    redis,
    orderEvents,
    wsGateway,
    authCookie(payload: Record<string, unknown>) {
      const token = jwt.sign(payload, process.env.ACCESS_SECRET!, {
        expiresIn: '1h',
      });
      return `access_token=${token}`;
    },
  };
}
