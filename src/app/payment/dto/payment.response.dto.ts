import { PaymentSessionEntity } from '../entity/payment-session.entity';
import { TransactionEntity } from '../entity/transaction.entity';
import { PaymentProviderName } from '../enums';

export class PaymentInitResponseDTO {
  sessionId!: number;
  providerSessionId!: string;
  redirectUrl!: string;
  expiresAt!: string | null;
  amount!: number;
  currency!: string;

  static from(
    session: PaymentSessionEntity,
    orderPublicId: string,
  ): PaymentInitResponseDTO {
    const dto = new PaymentInitResponseDTO();
    dto.sessionId = Number(session.id);
    dto.providerSessionId = session.providerSessionId;
    dto.redirectUrl = session.redirectUrl;
    dto.expiresAt = session.expiresAt
      ? new Date(session.expiresAt).toISOString()
      : null;
    dto.amount = Number(session.amount);
    dto.currency = session.currency;
    // orderPublicId currently unused in the body but kept on the signature so
    // future contract changes (e.g. echoing the order id back) don't reshape
    // every caller.
    void orderPublicId;
    return dto;
  }
}

export class PaymentResponseDTO {
  id!: number;
  orderPublicId!: string | null;
  type!: string;
  method!: string;
  provider?: string;
  providerReferenceId?: string;
  status!: string;
  amount!: number;
  currency!: string;
  isRefunded!: boolean;
  refundedPaymentId?: number;
  createdAt!: string;
  updatedAt!: string;

  static from(
    tx: TransactionEntity,
    orderPublicId: string | null,
    providerName?: string,
  ): PaymentResponseDTO {
    const dto = new PaymentResponseDTO();
    dto.id = Number(tx.id);
    dto.orderPublicId = orderPublicId;
    dto.type = tx.transactionType;
    dto.method = tx.method;
    if (providerName) dto.provider = providerName;
    if (tx.providerReferenceId) dto.providerReferenceId = tx.providerReferenceId;
    dto.status = tx.status;
    dto.amount = Number(tx.amount);
    dto.currency = tx.currency;
    dto.isRefunded = Boolean(tx.isRefunded);
    if (tx.refundedPaymentId) dto.refundedPaymentId = Number(tx.refundedPaymentId);
    dto.createdAt = new Date(tx.createdAt).toISOString();
    dto.updatedAt = new Date(tx.updatedAt).toISOString();
    return dto;
  }
}

export class RefundResponseDTO {
  refundId!: number;
  status!: string;
  amount!: number;
  currency!: string;

  static from(tx: TransactionEntity): RefundResponseDTO {
    const dto = new RefundResponseDTO();
    dto.refundId = Number(tx.id);
    dto.status = tx.status;
    dto.amount = Number(tx.amount);
    dto.currency = tx.currency;
    return dto;
  }
}

// Re-export the canonical provider name list so controllers/clients can
// validate URL params consistently without importing enums.ts everywhere.
export const PROVIDER_NAMES: readonly string[] = Object.values(
  PaymentProviderName,
);
