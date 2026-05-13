import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { ShardedKnex } from '../../lib/sharding/shards';
import { OrderService } from '../order/order.service';
import { PaymentSessionRepository } from './repository/payment-session.repository';
import { TransactionRepository } from './repository/transaction.repository';
import { PaymentWebhookEventRepository } from './repository/payment-webhook-event.repository';
import {
  PaymentSessionStatus,
  TransactionMethod,
  TransactionStatus,
  TransactionType,
} from './enums';
import { PAYMENT_ERRORS } from './payment.constants';
import { KashierProviderService } from './kashier-provider.service';
import { PaymentService } from './payment.service';
import {
  KashierWebhookData,
  KashierWebhookEnvelope,
} from '../../pkg/payments/kashier/kashier.types';
import { PaymentSessionEntity } from './entity/payment-session.entity';

@Injectable()
export class KashierWebhookService {
  private readonly logger = new Logger(KashierWebhookService.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly kashier: KashierProviderService,
    @Inject(forwardRef(() => OrderService))
    private readonly orderService: OrderService,
    private readonly sessionRepo: PaymentSessionRepository,
    private readonly txRepo: TransactionRepository,
    private readonly webhookRepo: PaymentWebhookEventRepository,
    private readonly paymentService: PaymentService,
  ) {}

  /**
   * Process a Kashier webhook delivery.
   *
   * Pipeline:
   *   1. Verify HMAC signature against `data.signatureKeys`. Reject 401 on miss.
   *   2. Load the local payment_session via `merchantOrderId` -> order or
   *      `kashierOrderId` -> session lookup. We use the ORDER lookup first
   *      since `merchantOrderId` is our own UUID.
   *   3. Insert into `payment_webhook_events` with ON CONFLICT DO NOTHING.
   *      A duplicate means we already processed it -> 200, no side effect.
   *   4. In one trx on the order's region: update session status, write the
   *      transactions row, advance order status (capture only). Stamp
   *      processed_at on the webhook row.
   */
  async handle(
    headers: Record<string, string | string[] | undefined>,
    rawBodyString: string,
  ): Promise<{ ok: boolean; alreadyProcessed?: boolean }> {
    const verify = this.kashier.verifyWebhook({
      rawBody: rawBodyString,
      headers,
    });
    if (!verify.ok) {
      this.logger.warn(
        `kashier webhook signature failed: ${verify.reason ?? 'unknown'}`,
      );
      throw new UnauthorizedException(PAYMENT_ERRORS.WEBHOOK_INVALID_SIGNATURE);
    }
    const envelope = verify.parsed as KashierWebhookEnvelope | undefined;
    if (!envelope || !envelope.data) {
      throw new BadRequestException('Malformed Kashier webhook payload');
    }
    console.log(envelope.data);
    const event = String(envelope.event ?? '').toLowerCase();
    const data = envelope.data;
    const merchantOrderId = String(data.merchantOrderId ?? '').trim();
    if (!merchantOrderId) {
      throw new BadRequestException('Missing merchantOrderId in webhook');
    }

    // Find the local order across the active regions to resolve the shard.
    const region = await this.resolveRegionForOrder(merchantOrderId);
    if (!region) {
      // No matching order — likely a misrouted event. Drop silently with 200.
      this.logger.warn(
        `kashier webhook for unknown merchantOrderId ${merchantOrderId}`,
      );
      return { ok: true };
    }
    const order = await this.orderService.findEntityByPublicId(
      region,
      merchantOrderId,
    );
    if (!order) {
      this.logger.warn(`order vanished mid-processing: ${merchantOrderId}`);
      return { ok: true };
    }

    // Latest session for the order. We don't strictly need it for `pay`, but
    // it gives us the local provider session id for the update.
    const session = await this.sessionRepo.findLatestActiveByOrderId(
      region,
      order.id,
      order.createdAt,
    );

    const providerEventId = this.deriveEventId(event, data);
    const providerId = await this.paymentService.findKashierProviderId(region);

    // Idempotency pin: insert OR ignore. A duplicate -> ack, no work.
    const inserted = await this.webhookRepo.insertOrIgnore(region, {
      region,
      providerId,
      providerEventId,
      eventType: event,
      signature: pickHeader(headers, 'x-kashier-signature') ?? null,
      payload: envelope,
    });
    if (!inserted) {
      this.logger.log(
        `kashier webhook duplicate ${event}/${providerEventId} acked`,
      );
      return { ok: true, alreadyProcessed: true };
    }

    let didCaptureSucceed = false;
    try {
      const trx: Knex.Transaction = await this.knex.db(region).transaction();
      try {
        didCaptureSucceed = await this.dispatch(
          event,
          region,
          order,
          session,
          data,
          trx,
        );
        await this.webhookRepo.markProcessed(region, inserted.id, trx);
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `kashier webhook ${event}/${providerEventId} failed: ${message}`,
      );
      await this.webhookRepo.markFailed(region, inserted.id, message);
      throw err;
    }

    // Post-commit settlement for successful captures: reserve stock and, if
    // unavailable, auto-cancel + refund. Runs outside the webhook trx so the
    // long-running core/Kashier HTTP calls don't hold a DB transaction.
    if (didCaptureSucceed) {
      try {
        await this.postCaptureSettlement(region, merchantOrderId);
      } catch (settlementErr) {
        this.logger.error(
          `post-capture settlement failed for ${merchantOrderId}: ${
            (settlementErr as Error).message
          }`,
        );
        // We still ack the webhook (200). The order's terminal state will be
        // reconciled by ops manually; Kashier replays don't help here.
      }
    }
    return { ok: true };
  }

  // ── dispatch by event type ────────────────────────────────────────────────
  // Returns true iff this delivery successfully captured an order — used by
  // handle() to drive post-commit stock reservation + auto-refund.
  private async dispatch(
    event: string,
    region: string,
    order: any,
    session: PaymentSessionEntity | null,
    data: KashierWebhookData,
    trx: Knex.Transaction,
  ): Promise<boolean> {
    const status = String(data.status ?? '').toUpperCase();
    const isSuccess = status === 'SUCCESS' || status === 'CAPTURED';

    switch (event) {
      case 'pay':
      case 'capture':
        if (isSuccess) {
          await this.handleCapture(region, order, session, data, trx);
          return true;
        }
        await this.handleFailure(region, order, session, data, trx);
        return false;
      case 'authorize':
        if (session) {
          await this.sessionRepo.updateStatus(region, session.id, {
            status: PaymentSessionStatus.AUTHORIZED,
            rawLastPayload: data,
          });
        }
        return false;
      case 'refund':

        await this.handleRefund(region, order, data, trx);
        return false;
      case 'void':
        if (session) {
          await this.sessionRepo.updateStatus(region, session.id, {
            status: PaymentSessionStatus.CANCELLED,
            rawLastPayload: data,
          });
        }
        return false;
      default:
        this.logger.log(`kashier webhook event ${event} acked, no-op`);
        return false;
    }
  }

  /**
   * After capture trx commits: reserve stock via core-service. If stock is
   * unavailable, the order is auto-cancelled and a Kashier refund is opened.
   * Outside the webhook trx because reserve/refund are HTTP calls.
   */
  private async postCaptureSettlement(
    region: string,
    orderPublicId: string,
  ): Promise<void> {
    const order = await this.orderService.findEntityByPublicId(
      region,
      orderPublicId,
    );
    if (!order) {
      this.logger.warn(
        `postCaptureSettlement: order ${orderPublicId} not found`,
      );
      return;
    }
    // If something already moved the order off placed (e.g. concurrent
    // cancel), don't touch stock.
    if (order.status !== 'placed') {
      return;
    }

    const reserve = await this.orderService.reserveStockForOnlineCapture(
      region,
      order,
    );
    if (reserve.ok) return;

    this.logger.warn(
      `stock unavailable after capture for order ${order.publicId}; auto-cancelling + refunding`,
    );
    await this.orderService.cancelPlacedOrderForStockFailure(region, order);

    // Find the charge to refund — it was just inserted by handleCapture.
    const txs = await this.txRepo.findByOrderId(
      region,
      order.id,
      order.createdAt,
    );
    const charge = txs.find(
      (t) => t.transactionType === 'charge' && t.status === 'succeeded',
    );
    if (!charge) {
      this.logger.error(
        `auto-refund: no succeeded charge found for order ${order.publicId}`,
      );
      return;
    }
    try {
      await this.paymentService.systemRefundCharge(
        region,
        Number(charge.id),
        'auto-refund: out of stock after capture',
      );
    } catch (err) {
      this.logger.error(
        `auto-refund failed for charge ${charge.id}: ${(err as Error).message}`,
      );
    }
  }

  private async handleCapture(
    region: string,
    order: any,
    session: PaymentSessionEntity | null,
    data: KashierWebhookData,
    trx: Knex.Transaction,
  ): Promise<void> {
    if (session) {
      await this.sessionRepo.updateStatus(region, session.id, {
        status: PaymentSessionStatus.CAPTURED,
        rawLastPayload: data,
      });
    }
    const providerId = await this.paymentService.findKashierProviderId(region);
    const idempotencyKey = `charge:${order.publicId}:${
      data.transactionId ?? this.deriveEventId('pay', data)
    }`;
    // Skip insert if a charge already landed for this event id.
    const existing = await this.txRepo.findByIdempotencyKey(region, idempotencyKey);
    if (!existing) {
      await this.txRepo.create(
        region,
        {
          region,
          orderId: order.id,
          orderCreatedAt: order.createdAt,
          transactionType: TransactionType.CHARGE,
          method: TransactionMethod.ONLINE,
          providerId,
          providerReferenceId: data.transactionId
            ? String(data.transactionId)
            : null,
          // Kashier's refund endpoint keys off the ORDER id, not the txn id.
          // Persist it now so refunds work without consulting the session row.
          providerOrderId: data.kashierOrderId
            ? String(data.kashierOrderId)
            : null,
          status: TransactionStatus.SUCCEEDED,
          amount: this.parseAmount(data, order.total),
          currency: String(data.currency ?? order.currency),
          srcAccId: order.customerId,
          dstAccId: null, // SYSTEM until commission/settlement at delivery
          idempotencyKey,
        },
        trx,
      );
    }
    await this.orderService.markPaymentCaptured(region, order, trx);
  }

  private async handleFailure(
    region: string,
    order: any,
    session: PaymentSessionEntity | null,
    data: KashierWebhookData,
    trx: Knex.Transaction,
  ): Promise<void> {
    if (session) {
      await this.sessionRepo.updateStatus(region, session.id, {
        status: PaymentSessionStatus.FAILED,
        rawLastPayload: data,
      });
    }
    const providerId = await this.paymentService.findKashierProviderId(region);
    const idempotencyKey = `charge_failed:${order.publicId}:${
      data.transactionId ?? this.deriveEventId('pay', data)
    }`;
    const existing = await this.txRepo.findByIdempotencyKey(region, idempotencyKey);
    if (!existing) {
      await this.txRepo.create(
        region,
        {
          region,
          orderId: order.id,
          orderCreatedAt: order.createdAt,
          transactionType: TransactionType.CHARGE,
          method: TransactionMethod.ONLINE,
          providerId,
          providerReferenceId: data.transactionId
            ? String(data.transactionId)
            : null,
          status: TransactionStatus.FAILED,
          amount: this.parseAmount(data, order.total),
          currency: String(data.currency ?? order.currency),
          srcAccId: order.customerId,
          dstAccId: null,
          idempotencyKey,
        },
        trx,
      );
    }
    await this.orderService.markPaymentFailed(region, order, trx);
  }

  private async handleRefund(
      region: string,
      order: any, // <-- ADDED
      data: KashierWebhookData,
      trx: Knex.Transaction, // <-- ADDED
  ): Promise<void> {
    const txId = String(data.transactionId ?? '').trim();
    if (!txId) {
      this.logger.warn('refund webhook missing transactionId; skipping');
      return;
    }

    // 1. Try to find if we already initiated this refund via API
    const existingRefunds = await this.knex
        .db(region)('transactions')
        .transacting(trx)
        .where('provider_reference_id', txId)
        .andWhere('transaction_type', TransactionType.REFUND);
    const existingRow = existingRefunds[0];

    // IF WE FOUND IT: It was an API refund. Just update it.
    if (existingRow) {
      await this.txRepo.updateStatus(region, Number(existingRow.id), {
        status: TransactionStatus.SUCCEEDED,
      });
      if (existingRow.refunded_payment_id) {
        await this.txRepo.markRefunded(region, Number(existingRow.refunded_payment_id), Number(existingRow.id));
      }
      return;
    }

    // ------------------------------------------------------------------
    // 2. SURPRISE DASHBOARD REFUND!
    // It is not in our database yet. We must create a new row.
    // ------------------------------------------------------------------
    this.logger.log(`processing external dashboard refund ${txId} for order ${order.publicId}`);

    // Find the original successful charge to attach this refund to
    const charges = await this.knex
        .db(region)('transactions')
        .transacting(trx)
        .where('order_id', order.id)
        .andWhere('transaction_type', TransactionType.CHARGE)
        .andWhere('status', TransactionStatus.SUCCEEDED)
        .orderBy('id', 'desc'); // get the latest successful charge

    const originalCharge = charges[0];
    if (!originalCharge) {
      this.logger.warn(`dashboard refund ${txId} arrived, but no original charge found for order ${order.id}`);
      return;
    }

    // Insert the brand new successful refund record
    const providerId = await this.paymentService.findKashierProviderId(region);
    const amount = this.parseAmount(data, 0); // Get actual refund amount from webhook

    const newRefund = await this.txRepo.create(
        region,
        {
          region,
          orderId: order.id,
          orderCreatedAt: order.createdAt,
          transactionType: TransactionType.REFUND,
          method: TransactionMethod.ONLINE,
          providerId,
          providerReferenceId: txId,
          status: TransactionStatus.SUCCEEDED,
          amount: amount,
          currency: String(data.currency ?? order.currency),
          srcAccId: null,
          dstAccId: order.customerId,
          idempotencyKey: `dashboard_refund:${txId}`, // Dedicated key so it never duplicates
          refundedPaymentId: Number(originalCharge.id), // Link it!
        },
        trx,
    );

    // Mark the original charge row's `is_refunded` flag
    await this.txRepo.markRefunded(region, Number(originalCharge.id), Number(newRefund.id));
  }
  // ── helpers ──────────────────────────────────────────────────────────────
  private async resolveRegionForOrder(
    publicId: string,
  ): Promise<string | null> {
    for (const region of this.knex.regions()) {
      try {
        const found = await this.orderService.findEntityByPublicId(
          region,
          publicId,
        );
        if (found) return region;
      } catch (err) {
        this.logger.warn(
          `region ${region} probe failed: ${(err as Error).message}`,
        );
      }
    }
    return null;
  }

  private deriveEventId(event: string, data: KashierWebhookData): string {
    const tx = data.transactionId ? String(data.transactionId) : 'no-tx';
    const order = data.merchantOrderId ? String(data.merchantOrderId) : 'no-order';
    return `${event}:${order}:${tx}`;
  }

  private parseAmount(data: KashierWebhookData, fallback: number): number {
    const v = data.amount;
    if (typeof v === 'number') return Math.round(v * 100);
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.round(n * 100);
    }
    return Number(fallback);
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
