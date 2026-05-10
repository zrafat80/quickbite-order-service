import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Reflector } from '@nestjs/core';
import { Observable, of, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { createHash } from 'crypto';
import {
  IDEMPOTENCY_KEY_METADATA,
  IdempotencyOptions,
} from './idempotency.decorator';

/**
 * Redis-backed idempotency for write endpoints.
 *
 * TODO Phase 1: once `idempotency_keys` table lands, add a DB-backed fallback
 * so a Redis outage doesn't lose the idempotency contract on critical writes
 * (POST /orders, POST /payments/init).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const method = request.method;

    if (!['POST', 'PATCH', 'PUT'].includes(method)) return next.handle();

    const options = this.reflector.get<IdempotencyOptions>(
      IDEMPOTENCY_KEY_METADATA,
      context.getHandler(),
    );
    if (!options) return next.handle();

    const idempotencyKey = request.headers['idempotency-key'];
    if (!idempotencyKey) {
      if (options.strict) {
        throw new BadRequestException('Idempotency-Key header is required');
      }
      return next.handle();
    }

    const userId = request.user?.userId ?? 'anon';
    const region = request.region ?? 'noregion';
    const cacheKey = `idempotency:${region}:${userId}:${method}:${request.originalUrl}:${idempotencyKey}`;
    const TTL_24_HOURS = 86_400_000; // ms
    const fingerprint = fingerprintRequestBody(request.body);

    try {
      const cachedResponse = await this.cacheManager.get<string>(cacheKey);
      if (cachedResponse) {
        if (cachedResponse === 'PROCESSING') {
          throw new ConflictException(
            'Request is currently processing. Please do not retry.',
          );
        }
        const parsed = parseEnvelope(cachedResponse);
        if (parsed?.fp && parsed.fp !== fingerprint) {
          throw new ConflictException(
            'Idempotency-Key reused with a different request body',
          );
        }
        return of(parsed?.body ?? JSON.parse(cachedResponse));
      }

      await this.cacheManager.set(cacheKey, 'PROCESSING', TTL_24_HOURS);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (options.strict) {
        throw new ServiceUnavailableException(
          'Idempotency storage is unavailable. Request blocked.',
        );
      }
      return next.handle();
    }

    return next.handle().pipe(
      tap((responseBody) => {
        const envelope = JSON.stringify({ fp: fingerprint, body: responseBody });
        this.cacheManager
          .set(cacheKey, envelope, TTL_24_HOURS)
          // eslint-disable-next-line no-console
          .catch((err: any) =>
            console.error(`Failed to update idempotency key: ${cacheKey}`, err),
          );
      }),
      catchError((error) => {
        this.cacheManager
          .del(cacheKey)
          // eslint-disable-next-line no-console
          .catch((e: any) =>
            console.error(`Failed to release idempotency lock: ${cacheKey}`, e),
          );
        return throwError(() => error);
      }),
    );
  }
}

function fingerprintRequestBody(body: unknown): string {
  const canonical = body === undefined || body === null ? '' : stableStringify(body);
  return createHash('sha256').update(canonical).digest('hex');
}

// Order-independent JSON serialization so {a:1,b:2} and {b:2,a:1} hash equal.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`)
    .join(',')}}`;
}

function parseEnvelope(raw: string): { fp?: string; body?: unknown } | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'fp' in parsed && 'body' in parsed) {
      return parsed as { fp?: string; body?: unknown };
    }
    return { body: parsed };
  } catch {
    return null;
  }
}
