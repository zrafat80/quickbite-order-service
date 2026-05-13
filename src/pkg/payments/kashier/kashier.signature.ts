import { createHmac, timingSafeEqual } from 'crypto';
import { KashierWebhookData } from './kashier.types';

/**
 * Order-hash for the Payment Session. Kashier expects HMAC-SHA256 of the
 * canonical path `/?payment=${mid}.${orderId}.${amount}.${currency}` signed
 * with the Payment API key. The hex result is sent in `paymentParams.hash`
 * on the session create request.
 *
 * Source: Kashier integration guide (`generateKashierOrderHash`).
 */
export function buildOrderHash(input: {
  merchantId: string;
  orderId: string;
  amount: string | number;
  currency: string;
  paymentApiKey: string;
}): string {
  const path = `/?payment=${input.merchantId}.${input.orderId}.${input.amount}.${input.currency}`;
  return createHmac('sha256', input.paymentApiKey).update(path).digest('hex');
}

/**
 * Webhook signature verification. Kashier signs only the keys listed under
 * `data.signatureKeys`, alphabetically sorted, joined as a URL-encoded query
 * string, then HMAC-SHA256 with the Payment API key. The result is sent in
 * `x-kashier-signature`.
 *
 * Source: Kashier "Webhook" docs.
 *
 * Returns the computed signature alongside the verdict so callers can log
 * mismatches without re-running the math.
 */
export function verifyWebhookSignature(input: {
  data: KashierWebhookData;
  receivedSignature: string | undefined;
  paymentApiKey: string;
}): { ok: boolean; expected: string; reason?: string } {
  if (!input.receivedSignature) {
    return { ok: false, expected: '', reason: 'missing x-kashier-signature' };
  }
  const keys = Array.isArray(input.data?.signatureKeys)
    ? [...input.data.signatureKeys].sort()
    : [];
  if (keys.length === 0) {
    return {
      ok: false,
      expected: '',
      reason: 'missing data.signatureKeys',
    };
  }
  const payload = buildSignaturePayload(input.data, keys);
  const expected = createHmac('sha256', input.paymentApiKey)
    .update(payload)
    .digest('hex');
  return {
    ok: constantTimeEquals(input.receivedSignature, expected),
    expected,
  };
}

function buildSignaturePayload(
  data: KashierWebhookData,
  sortedKeys: string[],
): string {
  // URL-encoded `key1=value1&key2=value2&...` exactly like
  // `query-string`'s default — value coerced to its primitive string form.
  const parts: string[] = [];
  for (const k of sortedKeys) {
    const v = (data as Record<string, unknown>)[k];
    parts.push(
      `${encodeURIComponent(k)}=${encodeURIComponent(stringifyValue(v))}`,
    );
  }
  return parts.join('&');
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function constantTimeEquals(a: string, b: string): boolean {
  const A = Buffer.from(a, 'utf8');
  const B = Buffer.from(b, 'utf8');
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}
