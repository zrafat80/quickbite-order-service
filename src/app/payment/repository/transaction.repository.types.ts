import {
  TransactionMethod,
  TransactionStatus,
  TransactionType,
} from '../enums';

export interface CreateTransactionInput {
  region: string;
  orderId: number | null;
  orderCreatedAt: Date | null;
  transactionType: TransactionType;
  method: TransactionMethod;
  providerId: number | null;
  providerReferenceId: string | null;
  providerOrderId?: string | null;
  status: TransactionStatus;
  amount: number;
  currency: string;
  srcAccId: number | null;
  dstAccId: number | null;
  refundedPaymentId?: number | null;
  idempotencyKey: string | null;
  reason?: string | null;
}

export interface UpdateTransactionStatusInput {
  status: TransactionStatus;
  providerReferenceId?: string;
}
