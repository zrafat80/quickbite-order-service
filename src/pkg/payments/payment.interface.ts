/**
 * Provider-agnostic payment surface. Concrete providers (Kashier today, Stripe
 * tomorrow) implement this interface in their own files under
 * `pkg/payments/<provider>/`. The Phase 2 payment module wires whichever
 * provider is configured into a NestJS service.
 *
 * Phase 0 declares the interface only — no provider implementations yet.
 */

export interface CreateSessionInput {
  orderId: string;
  amountMinor: number;
  currency: string;
  customer: { id: string; name: string; email?: string };
  metadata?: Record<string, string>;
  returnUrl: string;
  failUrl: string;
}

export interface CreateSessionResult {
  providerSessionId: string;
  redirectUrl: string;
  expiresAt: Date;
}

export interface RefundInput {
  providerChargeId: string;
  amountMinor: number;
  reason?: string;
  metadata?: Record<string, string>;
}

export interface RefundResult {
  providerRefundId: string;
}

export interface WebhookVerifyInput {
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
}

export interface WebhookVerifyResult {
  ok: boolean;
  reason?: string;
  parsed?: unknown;
}

export interface IPaymentProvider {
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  verifyWebhook(input: WebhookVerifyInput): WebhookVerifyResult;
}
