// Values must match the CHECK constraint on `payment_sessions.status`.
export enum PaymentSessionStatus {
  INITIALIZED = 'initialized',
  PENDING = 'pending',
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  FAILED = 'failed',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

// Values must match the CHECK constraint on `transactions.transaction_type`.
export enum TransactionType {
  CHARGE = 'charge',
  REFUND = 'refund',
  COMMISSION = 'commission',
  PAYOUT = 'payout',
  COD_COLLECTION = 'cod_collection',
  ADJUSTMENT = 'adjustment',
}

// Values must match the CHECK constraint on `transactions.method`.
export enum TransactionMethod {
  ONLINE = 'online',
  COD = 'cod',
  BANK_TRANSFER = 'bank_transfer',
  SYSTEM = 'system',
}

// Values must match the CHECK constraint on `transactions.status`.
export enum TransactionStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  REVERSED = 'reversed',
}

// Seed values: payment_providers.id == these literals (see migration).
export enum PaymentProviderId {
  KASHIER = 1,
  COD = 2,
}

export enum PaymentProviderName {
  KASHIER = 'kashier',
  COD = 'cod',
}
