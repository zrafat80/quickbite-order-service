import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Maps Postgres SQLSTATE codes to HTTP responses with the unified envelope.
 * HttpException subclasses fall through unchanged.
 */
@Catch()
export class DatabaseErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DatabaseErrorFilter.name);

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      return response
        .status(status)
        .json(
          typeof exceptionResponse === 'string'
            ? {
                statusCode: status,
                isSuccess: false,
                message: exceptionResponse,
                data: null,
              }
            : exceptionResponse,
        );
    }

    const code = exception.code;
    const message = exception.message || 'Internal server error';
    const detail = exception.detail || '';

    switch (code) {
      case '23505':
        return response.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          isSuccess: false,
          message: 'A record with the same unique value already exists. ' + detail,
          data: null,
        });

      case '23503':
        return response.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          isSuccess: false,
          message: 'Foreign key constraint failed. ' + detail,
          data: null,
        });

      case '23502':
        return response.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          isSuccess: false,
          message: 'Missing required field (cannot be null). ' + message,
          data: null,
        });

      case '42703':
        return response.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          isSuccess: false,
          message: 'Unknown column. ' + message,
          data: null,
        });

      case '22001':
        return response.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          isSuccess: false,
          message: 'Data too long for column. ' + message,
          data: null,
        });

      default:
        this.logger.error('Unhandled server error', exception);
        return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          isSuccess: false,
          message: 'Database operation failed or internal error occurred.',
          data: null,
        });
    }
  }
}
