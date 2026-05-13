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
  /**
   * Provider's identifier for the original charge transaction. For Kashier this
   * is `data.transactionId` from the capture webhook (`TX-…`). Stored locally
   * as `transactions.provider_reference_id`. Some providers' refund APIs key
   * off this — Kashier's does NOT, see `providerOrderId` below.
   */
  providerChargeId: string;
  /**
   * Provider's order-level identifier — only some providers expose this. For
   * Kashier it's `data.kashierOrderId` from the capture webhook and the refund
   * URL is `PUT /orders/{providerOrderId}/`. Stored locally as
   * `transactions.provider_order_id`. Optional so providers that don't need it
   * (or synthetic tests) can omit.
   */
  providerOrderId?: string;
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
