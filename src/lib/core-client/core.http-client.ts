import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestContextService } from '../context/request-context.service';
import { retry } from '../../pkg/utils/retry';
import { CoreClientRequest } from './core.http-client.types';

/**
 * Base HTTP client for sync calls to core-service. Phase 0 ships only the base
 * wrapper — endpoint-specific clients (branch.client, product.client, …) land
 * in their owning module phases.
 *
 *   - Sets `x-api-key` from `core.internalApiKey` on every request.
 *   - Forwards `X-CorrelationId` from `RequestContextService` so logs stitch.
 *   - Retries 3× with exponential backoff on 5xx / network errors (max 500ms).
 *   - Translates non-2xx into NestJS HttpException subclasses.
 *
 * Body serialization is JSON. 204s return `undefined`.
 */
@Injectable()
export class CoreHttpClient {
  private readonly logger = new Logger(CoreHttpClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly requestContext: RequestContextService,
  ) {
    this.baseUrl = this.configService.get<string>('core.baseUrl') ?? '';
    this.apiKey = this.configService.get<string>('core.internalApiKey') ?? '';
    if (!this.baseUrl) {
      this.logger.warn(
        'core.baseUrl not configured; outbound calls to core will fail.',
      );
    }
  }

  async request<T>(req: CoreClientRequest): Promise<T> {
    const url = this.buildUrl(req.path, req.query);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      ...(req.headers ?? {}),
    };

    const correlationId = this.requestContext.getCorrelationId();
    if (correlationId) headers['X-CorrelationId'] = correlationId;
    if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;

    return retry(
      async () => {
        const res = await fetch(url, {
          method: req.method,
          headers,
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        });

        if (res.status >= 500) {
          throw new ServiceUnavailableException(
            `core upstream ${res.status}: ${await safeText(res)}`,
          );
        }
        if (!res.ok) {
          throw translateUpstream(res.status, await safeText(res));
        }
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      },
      {
        attempts: 3,
        initialDelayMs: 50,
        maxDelayMs: 500,
        isRetryable: (err) =>
          err instanceof ServiceUnavailableException ||
          !(err instanceof HttpException),
      },
    );
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function translateUpstream(status: number, body: string): HttpException {
  const message = body || `core upstream ${status}`;
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return new BadRequestException(message);
    case HttpStatus.UNAUTHORIZED:
      return new UnauthorizedException(message);
    case HttpStatus.FORBIDDEN:
      return new ForbiddenException(message);
    case HttpStatus.NOT_FOUND:
      return new NotFoundException(message);
    case HttpStatus.CONFLICT:
      return new ConflictException(message);
    default:
      return new HttpException(message, status);
  }
}
