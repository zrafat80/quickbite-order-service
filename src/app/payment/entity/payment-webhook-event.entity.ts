export class PaymentWebhookEventEntity {
  id!: number;
  region!: string;
  providerId!: number;
  providerEventId!: string;
  eventType!: string;
  signature!: string | null;
  payload!: unknown;
  receivedAt!: Date;
  processedAt!: Date | null;
  processError!: string | null;

  constructor(data: Partial<PaymentWebhookEventEntity>) {
    Object.assign(this, data);
  }
}
