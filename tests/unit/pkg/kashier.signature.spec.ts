import { createHmac } from 'crypto';
import {
  buildOrderHash,
  verifyWebhookSignature,
} from 'src/pkg/payments/kashier/kashier.signature';

describe('Kashier signatures', () => {
  it('builds the documented order hash', () => {
    const path = '/?payment=mid.order-1.12.50.EGP';
    const expected = createHmac('sha256', 'api-key')
      .update(path)
      .digest('hex');
    expect(
      buildOrderHash({
        merchantId: 'mid',
        orderId: 'order-1',
        amount: '12.50',
        currency: 'EGP',
        paymentApiKey: 'api-key',
      }),
    ).toBe(expected);
  });

  it('verifies sorted, encoded webhook fields', () => {
    const data = {
      signatureKeys: ['status', 'merchantOrderId', 'amount'],
      merchantOrderId: 'order 1',
      status: 'SUCCESS',
      amount: 12.5,
    } as never;
    const payload = 'amount=12.5&merchantOrderId=order%201&status=SUCCESS';
    const signature = createHmac('sha256', 'api-key')
      .update(payload)
      .digest('hex');

    expect(
      verifyWebhookSignature({
        data,
        receivedSignature: signature,
        paymentApiKey: 'api-key',
      }),
    ).toEqual({ ok: true, expected: signature });
    expect(
      verifyWebhookSignature({
        data,
        receivedSignature: 'wrong',
        paymentApiKey: 'api-key',
      }).ok,
    ).toBe(false);
  });

  it('rejects missing signatures and signature keys', () => {
    expect(
      verifyWebhookSignature({
        data: { signatureKeys: ['status'] } as never,
        receivedSignature: undefined,
        paymentApiKey: 'api-key',
      }),
    ).toMatchObject({ ok: false, reason: 'missing x-kashier-signature' });
    expect(
      verifyWebhookSignature({
        data: {} as never,
        receivedSignature: 'signature',
        paymentApiKey: 'api-key',
      }),
    ).toMatchObject({ ok: false, reason: 'missing data.signatureKeys' });
  });
});
