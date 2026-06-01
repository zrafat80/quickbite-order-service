import { TransactionMethod, TransactionStatus, TransactionType } from '../enums';

export class TransactionEntity {
  id!: number;
  region!: string;
  orderId!: number | null;
  orderCreatedAt!: Date | null;
  transactionType!: TransactionType;
  method!: TransactionMethod;
  providerId!: number | null;
  providerReferenceId!: string | null;
  providerOrderId!: string | null;
  status!: TransactionStatus;
  amount!: number;
  currency!: string;
  srcAccId!: number | null;
  dstAccId!: number | null;
  isRefunded!: boolean;
  refundedPaymentId!: number | null;
  idempotencyKey!: string | null;
  reason!: string | null;
  createdAt!: Date;
  updatedAt!: Date;

  constructor(data: Partial<TransactionEntity>) {
    Object.assign(this, data);
  }
}
