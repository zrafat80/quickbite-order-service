import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminusModule } from '@nestjs/terminus';
import { createKeyv } from '@keyv/redis';

import appConfig from './lib/config/app.config';
import { ContextModule } from './lib/context/context.module';
import { CorrelationMiddleware } from './lib/middleware/correlation.middleware';
import { HttpExceptionFilter } from './lib/filters/http-exception.filter';
import { DatabaseErrorFilter } from './lib/filters/database-error.filter';
import { SuccessInterceptor } from './lib/interceptors/success.interceptor';
import { DatabaseLoggerService } from './lib/logging/database-logger.service';
import { LoggingInterceptor } from './lib/logging/logging.interceptor';
import { DatabaseModule } from './lib/database.module';
import { ShardingModule } from './lib/sharding/sharding.module';
import { RegionResolverMiddleware } from './lib/sharding/region-resolver.middleware';
import { RedisModule } from './lib/cache/redis.module';
import { MessagingModule } from './lib/messaging/messaging.module';
import { CoreEventsModule } from './lib/core-events/core-events.module';
import { CacheInvalidationModule } from './lib/core-events/cache-invalidation.module';
import { CoreClientModule } from './lib/core-client/core-client.module';
import { AuthUtilsModule } from './lib/auth/auth-utils.module';
import { PermissionsModule } from './lib/middleware/guards/permissions.module';
import { WsModule } from './lib/websocket/ws.module';
import { HealthModule } from './app/health/health.module';
import { OrderModule } from './app/order/order.module';
import { PaymentModule } from './app/payment/payment.module';
import { PresenceModule } from './app/presence/presence.module';
import { AgentModule } from './app/agent/agent.module';
import { RestaurantFinanceModule } from './app/restaurant-finance/restaurant-finance.module';
import { JobsModule } from './lib/jobs/jobs.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),

    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const host = configService.get<string>('redis.host') ?? 'localhost';
        const port = configService.get<number>('redis.port') ?? 6379;
        const password = configService.get<string>('redis.password');
        const auth = password ? `:${password}@` : '';
        return {
          stores: [createKeyv(`redis://${auth}${host}:${port}`)],
          ttl: 3600000,
        };
      },
    }),

    ScheduleModule.forRoot(),
    TerminusModule,

    // Cross-cutting infra (all @Global())
    ContextModule,
    DatabaseModule,
    ShardingModule,
    RedisModule,
    MessagingModule,
    CoreEventsModule,
    CacheInvalidationModule,
    CoreClientModule,
    AuthUtilsModule,
    PermissionsModule,
    WsModule,

    // Domain modules
    HealthModule,
    OrderModule,
    PaymentModule,
    PresenceModule,
    AgentModule,
    RestaurantFinanceModule,
    JobsModule,
  ],
  controllers: [],
  providers: [
    DatabaseLoggerService,
    // DatabaseErrorFilter must come BEFORE HttpExceptionFilter in the array so
    // PG SQLSTATE codes get mapped to the right HTTP status before falling
    // through to the generic exception filter. Nest applies APP_FILTER providers
    // in reverse-registration order, so list specific → general.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_FILTER, useClass: DatabaseErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SuccessInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(CorrelationMiddleware, RegionResolverMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
