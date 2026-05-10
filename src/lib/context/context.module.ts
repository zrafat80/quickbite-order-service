import { Global, Module } from '@nestjs/common';
import { RequestContextService } from './request-context.service';

/**
 * Global so any provider in any module can inject `RequestContextService`
 * to read the per-request correlation id without each consumer having to
 * import the context module.
 */
@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class ContextModule {}
