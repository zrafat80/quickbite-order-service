import { SetMetadata } from '@nestjs/common';

export interface IdempotencyOptions {
  strict?: boolean;
}

export const IDEMPOTENCY_KEY_METADATA = 'idempotency_options';

export const Idempotency = (options: IdempotencyOptions = { strict: false }) =>
  SetMetadata(IDEMPOTENCY_KEY_METADATA, options);
