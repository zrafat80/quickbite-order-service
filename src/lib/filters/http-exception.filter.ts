import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { RequestContextService } from '../context/request-context.service';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly context: RequestContextService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const correlationId = this.context.getCorrelationId();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: any = 'Internal server error';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      message = (exceptionResponse as any).message || exceptionResponse;
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    this.logger.error(
      `[${correlationId ?? 'N/A'}] ${statusCode} ${typeof message === 'string' ? message : JSON.stringify(message)}`,
    );

    response.status(statusCode).json({
      statusCode,
      isSuccess: false,
      message,
      data: null,
      correlationId: correlationId || null,
      timestamp: new Date().toISOString(),
    });
  }
}
