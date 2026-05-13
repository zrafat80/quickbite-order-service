import { retry } from '../../utils/retry';
import {
  CreateSessionInput,
  CreateSessionResult,
  IPaymentProvider,
  RefundInput,
  RefundResult,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from '../payment.interface';
import {
  KashierClientConfig,
  KashierCreateSessionRequest,
  KashierCreateSessionResponse,
  KashierRefundRequest,
  KashierRefundResponse,
  KashierWebhookEnvelope,
} from './kashier.types';
import { verifyWebhookSignature } from './kashier.signature';

/**
 * Kashier v3 HTTP client. Framework-agnostic, no NestJS.
 *
 *   - createSession  -> POST {baseUrl}/v3/payment/sessions
 *   - refund         -> PUT  {fepUrl}/orders/{providerChargeId}/
 *   - verifyWebhook  -> HMAC-SHA256 over alphabetized `signatureKeys`
 *
 * Authorization: secretKey on every API call. The Payment API key (`apiKey`)
 * also goes on as `api-key` (sessions) and is used for hashing.
 *
 * Retries: 3x with exponential backoff on 5xx / network errors only. 4xx
 * errors are surfaced immediately so the caller can decide what to do.
 */
export class KashierClient implements IPaymentProvider {
  constructor(private readonly cfg: KashierClientConfig) {}

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const expireAt = new Date(
      Date.now() + this.cfg.paymentSessionTimeoutMin * 60_000,
    ).toISOString();

    const amountStr = String(input.amountMinor / 100); // Kashier expects major units

    // NOTE: order-hash is NOT a request field on /v3/payment/sessions — it
    // belongs to the older HPP flow. The session API returns its own hash in
    // `paymentParams.hash`. We still expose buildOrderHash() in the signature
    // module so callers using HPP can compute it.

    const body: KashierCreateSessionRequest = {
      amount: amountStr,
      currency: input.currency,
      paymentType: 'credit',
      order: input.orderId,
      merchantId: this.cfg.merchantId,
      expireAt,
      type: 'one-time',
      merchantRedirect: input.returnUrl,
      // Kashier requires `customer` to be present. Reference only — no email.
      customer: { reference: input.customer.id },
      ...(input.metadata ? { metaData: input.metadata } : {}),
      ...(input.metadata?.serverWebhook
        ? { serverWebhook: String(input.metadata.serverWebhook) }
        : {}),
      description: input.metadata?.description as string | undefined,
    };

    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/v3/payment/sessions`;
    const json = await this.requestJson<KashierCreateSessionResponse>(
      'POST',
      url,
      body,
      {
        Authorization: this.cfg.secretKey,
        'api-key': this.cfg.apiKey,
      },
    );
    const payload = json.response ?? json;
    const sessionId = payload._id as string | undefined;
    const sessionUrl = payload.sessionUrl as string | undefined;
    if (!sessionId || !sessionUrl) {
      throw new Error(
        `Kashier createSession: missing _id/sessionUrl in response: ${JSON.stringify(json)}`,
      );
    }
    return {
      providerSessionId: sessionId,
      redirectUrl: sessionUrl,
      expiresAt: new Date(payload.expireAt ?? expireAt),
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const body: KashierRefundRequest = {
      apiOperation: 'REFUND',
      reason: input.reason ?? 'customer refund',
      transaction: { amount: input.amountMinor / 100 },
    };

    const pathId = input.providerOrderId ?? input.providerChargeId;
    const url = `${this.cfg.fepUrl.replace(/\/$/, '')}/orders/${encodeURIComponent(
        pathId,
    )}/`;

    let json;
    try {
      json = await this.requestJson<KashierRefundResponse>('PUT', url, body, {
        Authorization: this.cfg.secretKey,
      });
    } catch (error: any) {
      // THIS WILL FINALLY PRINT THE TRUTH
      console.error('--- KASHIER API REJECTED THE REFUND ---');
      console.error('URL:', url);
      if (error.response && error.response.data) {
        console.error('RAW KASHIER ERROR:', JSON.stringify(error.response.data, null, 2));
      } else {
        console.error('ERROR MESSAGE:', error.message);
      }
      console.error('-----------------------------------------');
      throw error;
    }

    const inner = json.response;
    const outerStatus = (json.status ?? '').toString().toUpperCase();
    const innerStatus = (inner?.status ?? '').toString().toUpperCase();

    if (outerStatus !== 'SUCCESS' && innerStatus !== 'SUCCESS') {
      throw new Error(
          `Kashier refund failed: ${json.messages?.en ?? JSON.stringify(json)}`,
      );
    }

    return {
      providerRefundId: inner?.transactionId ?? input.providerChargeId,
    };
  }
  verifyWebhook(input: WebhookVerifyInput): WebhookVerifyResult {
    const raw = input.rawBody;
    let parsed: KashierWebhookEnvelope;
    try {
      parsed =
        typeof raw === 'string'
          ? (JSON.parse(raw) as KashierWebhookEnvelope)
          : (JSON.parse(raw.toString('utf8')) as KashierWebhookEnvelope);
    } catch (err) {
      return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
    }
    const headerName = 'x-kashier-signature';
    const sig = pickHeader(input.headers, headerName);
    const result = verifyWebhookSignature({
      data: parsed?.data ?? {},
      receivedSignature: sig,
      paymentApiKey: this.cfg.webhookSecret,
    });
    return { ok: result.ok, reason: result.reason, parsed };
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private async requestJson<T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<T> {
    return retry(
      async () => {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await safeText(res);
        if (res.status >= 500) {
          // retryable
          const e = new Error(
            `Kashier ${method} ${url} -> ${res.status}: ${text}`,
          ) as Error & { retryable?: boolean };
          e.retryable = true;
          throw e;
        }
        if (!res.ok) {
          // 4xx: surface as non-retryable
          const e = new Error(
            `Kashier ${method} ${url} -> ${res.status}: ${text}`,
          );
          throw e;
        }
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`Kashier ${method} ${url}: non-JSON response: ${text}`);
        }
      },
      {
        attempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 500,
        isRetryable: (err) => Boolean((err as { retryable?: boolean }).retryable),
      },
    );
  }
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
