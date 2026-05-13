import { PaymentSessionStatus } from '../enums';

export interface CreatePaymentSessionInput {
  region: string;
  orderId: number;
  orderCreatedAt: Date;
  providerId: number;
  providerSessionId: string;
  redirectUrl: string;
  amount: number;
  currency: string;
  status: PaymentSessionStatus;
  rawInitPayload: unknown;
  expiresAt: Date | null;
}

export interface UpdatePaymentSessionStatusInput {
  status: PaymentSessionStatus;
  rawLastPayload?: unknown;
}
