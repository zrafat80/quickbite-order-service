import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

const DEFAULT_MESSAGE = 'Operation succeeded';

interface Envelope {
  isSuccess: true;
  statusCode: number;
  message: string;
  data: unknown;
  meta?: unknown;
}

/**
 * Wraps every response in `{ isSuccess, statusCode, message, data }` (with
 * `meta` hoisted alongside for paginated responses). Hoisting rules applied
 * to the raw payload:
 *   - `message: string`  → top-level `message` (else default).
 *   - `meta` defined     → top-level `meta` (paginated marker).
 *   - `data` + `meta`    → top-level `data` is the inner array (paginated).
 *   - everything else    → top-level `data` is "the rest" (or null if empty).
 *
 * Primitives / arrays / null pass through as `data` with the default message.
 */
@Injectable()
export class SuccessInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const response = context.switchToHttp().getResponse();

    return next.handle().pipe(
      map((resPayload) => buildEnvelope(resPayload, response.statusCode)),
    );
  }
}

function buildEnvelope(payload: unknown, statusCode: number): Envelope {
  // Primitives, arrays, and null/undefined go straight into `data`.
  if (payload === null || payload === undefined) {
    return { isSuccess: true, statusCode, message: DEFAULT_MESSAGE, data: null };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { isSuccess: true, statusCode, message: DEFAULT_MESSAGE, data: payload };
  }

  const { message, meta, data: innerData, ...rest } = payload as Record<string, unknown>;
  const finalMessage = typeof message === 'string' ? message : DEFAULT_MESSAGE;
  const isPaginated = meta !== undefined && innerData !== undefined;

  let finalData: unknown;
  if (isPaginated) {
    finalData = innerData;
  } else {
    // Re-attach the `data` key when it existed without `meta` (a service may
    // legitimately return a top-level `data` field that isn't a pagination
    // wrapper — keep it inside `data` rather than silently dropping it).
    if (innerData !== undefined) rest.data = innerData;
    finalData = Object.keys(rest).length > 0 ? rest : null;
  }

  const envelope: Envelope = {
    isSuccess: true,
    statusCode,
    message: finalMessage,
    data: finalData,
  };
  if (meta !== undefined) envelope.meta = meta;
  return envelope;
}
