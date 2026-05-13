/**
 * Provider-shape types for Kashier v3. Kept narrow on purpose — only what we
 * actually consume goes here. Verbose Kashier responses are still preserved
 * in `payment_sessions.raw_init_payload` and `payment_webhook_events.payload`
 * for replay/audit.
 */

export interface KashierClientConfig {
  baseUrl: string; // e.g. https://test-api.kashier.io
  fepUrl: string; // e.g. https://test-fep.kashier.io  (refund endpoint)
  merchantId: string; // e.g. MID-45694-556
  apiKey: string; // Payment API key (api-key header + hash + webhook signature)
  secretKey: string; // Authorization header for session/refund
  webhookSecret: string; // typically same as apiKey
  paymentSessionTimeoutMin: number;
}

// Kashier event types delivered to the webhook.
export type KashierEventType =
  | 'pay'
  | 'refund'
  | 'authorize'
  | 'capture'
  | 'void';

// Payment Session creation request body (only fields we send).
export interface KashierCreateSessionRequest {
  amount: string; // string per Kashier spec
  currency: string; // 'EGP', 'SAR'
  paymentType: string; // 'credit'
  order: string; // merchantOrderId — we use order.publicId (UUID)
  merchantId: string;
  expireAt: string; // ISO 8601
  type?: string; // 'one-time'
  merchantRedirect: string; // returnUrl
  failureRedirect?: string;
  serverWebhook?: string;
  enable3DS?: boolean;
  hash?: string;
  description?: string;
  metaData?: Record<string, unknown>;
  // Kashier requires the `customer` object. We only send `reference` —
  // user explicitly opted out of forwarding email.
  customer?: { reference?: string; email?: string };
}

// Payment Session creation response (only fields we consume).
export interface KashierCreateSessionResponse {
  status?: string;
  _id?: string; // session id
  merchantId?: string;
  expireAt?: string;
  sessionUrl?: string; // hosted checkout URL
  paymentParams?: { hash?: string };
  // Kashier sometimes wraps the actual payload in `response`.
  response?: KashierCreateSessionResponse;
  [key: string]: unknown;
}

// Webhook envelope shape (top-level).
export interface KashierWebhookEnvelope {
  event: KashierEventType | string;
  data: KashierWebhookData;
  [key: string]: unknown;
}

// Webhook `data` object — we consume a subset; rest survives in raw payload.
export interface KashierWebhookData {
  signatureKeys?: string[];
  // Common fields seen across event types.
  merchantOrderId?: string; // our public_id
  kashierOrderId?: string;
  orderReference?: string;
  transactionId?: string;
  status?: string;
  method?: string;
  amount?: number | string;
  currency?: string;
  reason?: string;
  // Allow any other Kashier-supplied fields without forcing typing.
  [key: string]: unknown;
}

export interface KashierRefundRequest {
  apiOperation: 'REFUND';
  reason: string;
  transaction: { amount: number };
}

export interface KashierRefundResponse {
  response?: {
    status?: string; // SUCCESS | FAILURE
    gatewayCode?: string;
    transactionId?: string;
    transactionDate?: string;
    amount?: number;
    currency?: string;
    operation?: string;
  };
  status?: string;
  messages?: { en?: string; ar?: string };
  [key: string]: unknown;
}
