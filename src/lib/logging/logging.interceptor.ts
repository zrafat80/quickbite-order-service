import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Request } from 'express';
import { DatabaseLoggerService } from './database-logger.service';
import { RequestContextService } from '../context/request-context.service';
import { Log } from './log.interface';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly logger: DatabaseLoggerService,
    private readonly requestContext: RequestContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const startTime = Date.now();
    const correlationId = this.requestContext.getCorrelationId();
    const request = context.switchToHttp().getRequest<Request>();

    const userId = request.user?.userId;
    const logData: Log = {
      packetType: 'request',
      correlationId,
      userId,
      ipAddress: request.ip || 'unknown',
      userAgent: request.headers['user-agent'] || 'unknown',
      action: `${context.getClass().name}.${context.getHandler().name}`,
      endpoint: request.originalUrl,
      method: request.method,
      region: request.region,
    };

    return next.handle().pipe(
      tap(() => {
        logData.packetType = 'response';
        logData.responseTime = Date.now() - startTime;
        this.logger.log(logData);
      }),
      catchError((error) => {
        logData.packetType = 'response';
        logData.responseTime = Date.now() - startTime;
        logData.trace = error.stack;
        logData.errorMessage = error.message;
        this.logger.error(logData);

        throw error;
      }),
    );
  }
}
