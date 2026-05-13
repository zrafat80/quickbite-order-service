import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import { ShardedKnex } from '../../lib/sharding/shards';
import { OrderService } from '../order/order.service';
import { OrderEntity } from '../order/entity/order.entity';
import { OrderOwnershipView } from '../order/repository/order.repository.types';
import { OrderStatus, PaymentMethod } from '../order/enums';
import { PaymentSessionRepository } from './repository/payment-session.repository';
import { TransactionRepository } from './repository/transaction.repository';
import { PaymentProviderRepository } from './repository/payment-provider.repository';
import { PaymentSessionEntity } from './entity/payment-session.entity';
import { TransactionEntity } from './entity/transaction.entity';
import {
  PaymentProviderId,
  PaymentProviderName,
  PaymentSessionStatus,
  TransactionMethod,
  TransactionStatus,
  TransactionType,
} from './enums';
import { PAYMENT_ERRORS } from './payment.constants';
import { KashierProviderService } from './kashier-provider.service';
import { AuthenticatedUser, InitPaymentResult } from './payment.service.types';
import { RefundRequestDTO } from './dto/refund.request.dto';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => OrderService))
    private readonly orderService: OrderService,
    private readonly sessionRepo: PaymentSessionRepository,
    private readonly txRepo: TransactionRepository,
    private readonly providerRepo: PaymentProviderRepository,
    private readonly kashier: KashierProviderService,
  ) {}

  // ─── POST /payments/init (or auto-init from POST /orders) ─────────────────
  /**
   * Initializes a Kashier session for an online order. Idempotent at the
   * domain level: if a session already exists for the order with a non-final
   * status, the existing one is returned. The interceptor also dedupes via
   * `Idempotency-Key` for HTTP-level retries.
   *
   * `actor` is the customer initiating; for the auto-init path from
   * OrderService it's the same authenticated user.
   */
  async init(
    actor: AuthenticatedUser,
    region: string,
    orderPublicId: string,
  ): Promise<InitPaymentResult> {
    if (!region) throw new BadRequestException(PAYMENT_ERRORS.REGION_REQUIRED);

    const order = await this.orderService.findEntityByPublicId(
      region,
      orderPublicId,
    );
    if (!order) throw new NotFoundException(PAYMENT_ERRORS.ORDER_NOT_FOUND);

    if (
      actor.role !== 'system_admin' &&
      Number(order.customerId) !== Number(actor.userId)
    ) {
      throw new ForbiddenException(PAYMENT_ERRORS.CUSTOMER_ONLY);
    }

    if (order.paymentMethod !== PaymentMethod.ONLINE) {
      throw new ConflictException(PAYMENT_ERRORS.ORDER_NOT_PENDING_PAYMENT);
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ConflictException(PAYMENT_ERRORS.ORDER_NOT_PENDING_PAYMENT);
    }

    // Domain idempotency: reuse the latest active session if one exists.
    const existing = await this.sessionRepo.findLatestActiveByOrderId(
      region,
      order.id,
      order.createdAt,
    );
    if (existing) {
      return { session: existing, order };
    }

    const provider = await this.providerRepo.findByName(
      region,
      PaymentProviderName.KASHIER,
    );
    if (!provider || !provider.isEnabled) {
      throw new ConflictException(PAYMENT_ERRORS.PAYMENT_PROVIDER_DISABLED);
    }

    const returnUrl =
      this.configService.get<string>('kashier.returnUrl') ?? '';
    const failUrl = this.configService.get<string>('kashier.failUrl') ?? '';
    const serverWebhook =
      this.configService.get<string>('kashier.serverWebhookUrl') || undefined;

    let providerResult;
    try {
      providerResult = await this.kashier.createSession({
        orderId: order.publicId,
        amountMinor: Number(order.total),
        currency: order.currency,
        customer: { id: String(order.customerId), name: 'Customer' },
        returnUrl,
        failUrl,
        metadata: serverWebhook ? { serverWebhook } : undefined,
      });
    } catch (err) {
      this.logger.error(
        `kashier createSession failed for order ${order.publicId}: ${
          (err as Error).message
        }`,
      );
      throw new ServiceUnavailableException(
        PAYMENT_ERRORS.PROVIDER_UNAVAILABLE,
      );
    }

    const session = await this.sessionRepo.create(region, {
      region,
      orderId: order.id,
      orderCreatedAt: order.createdAt,
      providerId: provider.id,
      providerSessionId: providerResult.providerSessionId,
      redirectUrl: providerResult.redirectUrl,
      amount: Number(order.total),
      currency: order.currency,
      status: PaymentSessionStatus.INITIALIZED,
      rawInitPayload: {
        request: {
          orderId: order.publicId,
          amount: order.total,
          currency: order.currency,
        },
        response: {
          providerSessionId: providerResult.providerSessionId,
          redirectUrl: providerResult.redirectUrl,
          expiresAt: providerResult.expiresAt.toISOString(),
        },
      },
      expiresAt: providerResult.expiresAt,
    });

    return { session, order };
  }

  // ─── GET /payments/{id} ───────────────────────────────────────────────────
  async getById(
    actor: AuthenticatedUser,
    region: string,
    id: number,
  ): Promise<{ tx: TransactionEntity; order: OrderOwnershipView | null; providerName?: string }> {
    if (!region) throw new BadRequestException(PAYMENT_ERRORS.REGION_REQUIRED);
    const tx = await this.txRepo.findById(region, id);
    if (!tx) throw new NotFoundException(PAYMENT_ERRORS.PAYMENT_NOT_FOUND);

    let order: OrderOwnershipView | null = null;
    if (tx.orderId && tx.orderCreatedAt) {
      order = await this.orderService.findOwnershipById(
        region,
        tx.orderId,
        tx.orderCreatedAt,
      );
    }

    // Authorization: system_admin always; restaurant owner of the order.
    const canRead =
      actor.role === 'system_admin' ||
      (order &&
        actor.role === 'restaurant_user' &&
        Number(actor.restaurantId) === Number(order.restaurantId));
    if (!canRead) throw new ForbiddenException(PAYMENT_ERRORS.ADMIN_ONLY);

    let providerName: string | undefined;
    if (tx.providerId) {
      const p = await this.providerRepo.findById(region, tx.providerId);
      providerName = p?.name;
    }
    return { tx, order, providerName };
  }

  // ─── POST /payments/{id}/refund ───────────────────────────────────────────
  async refund(
    actor: AuthenticatedUser,
    region: string,
    chargeId: number,
    body: RefundRequestDTO,
    idempotencyKey: string,
  ): Promise<TransactionEntity> {
    if (!region) throw new BadRequestException(PAYMENT_ERRORS.REGION_REQUIRED);
    if (actor.role !== 'system_admin') {
      throw new ForbiddenException(PAYMENT_ERRORS.ADMIN_ONLY);
    }
    return this.executeRefund(region, chargeId, body.amount, body.reason, idempotencyKey);
  }

  /**
   * Internal refund entry point used by the auto-refund path (capture
   * succeeded but stock unavailable). Bypasses the JWT actor check; full
   * remaining amount is refunded.
   */
  async systemRefundCharge(
    region: string,
    chargeId: number,
    reason: string,
  ): Promise<TransactionEntity> {
    if (!region) throw new BadRequestException(PAYMENT_ERRORS.REGION_REQUIRED);
    const idempotencyKey = `auto_refund_stock:charge_${chargeId}`;
    return this.executeRefund(region, chargeId, undefined, reason, idempotencyKey);
  }

  private async executeRefund(
    region: string,
    chargeId: number,
    amount: number | undefined,
    reason: string | undefined,
    idempotencyKey: string,
  ): Promise<TransactionEntity> {
    const charge = await this.txRepo.findById(region, chargeId);
    if (!charge) throw new NotFoundException(PAYMENT_ERRORS.PAYMENT_NOT_FOUND);
    if (
      charge.transactionType !== TransactionType.CHARGE ||
      charge.status !== TransactionStatus.SUCCEEDED
    ) {
      throw new ConflictException(PAYMENT_ERRORS.REFUND_NOT_ELIGIBLE);
    }

    // Compute remaining refundable amount from existing refund chain.
    const priorRefunds = await this.txRepo.findRefundsForCharge(
      region,
      chargeId,
    );
    const refundedSoFar = priorRefunds
      .filter((r) =>
        [TransactionStatus.PENDING, TransactionStatus.SUCCEEDED].includes(
          r.status,
        ),
      )
      .reduce((acc, r) => acc + Number(r.amount), 0);
    const remaining = Number(charge.amount) - refundedSoFar;
    if (remaining <= 0) {
      throw new ConflictException(PAYMENT_ERRORS.REFUND_NOT_ELIGIBLE);
    }
    const requested = amount ?? remaining;
    if (requested > remaining) {
      throw new ConflictException(PAYMENT_ERRORS.REFUND_AMOUNT_TOO_LARGE);
    }

    // Persist the refund row in `pending` first (idempotency_key derived
    // from the original charge so the same retry collapses to the same row
    // via the unique constraint on idempotency_key).

    const existing = await this.txRepo.findByIdempotencyKey(
      region,
      idempotencyKey,
    );
    if (existing) {
      this.logger.log(
        `refund replay for charge ${charge.id} -> tx ${existing.id}`,
      );
      return existing;
    }

    const trx: Knex.Transaction = await this.knex.db(region).transaction();
    let refund: TransactionEntity;
    try {
      refund = await this.txRepo.create(
        region,
        {
          region,
          orderId: charge.orderId,
          orderCreatedAt: charge.orderCreatedAt,
          transactionType: TransactionType.REFUND,
          method: charge.method,
          providerId: charge.providerId,
          providerReferenceId: null,
          status: TransactionStatus.PENDING,
          amount: requested,
          currency: charge.currency,
          srcAccId: null, // SYSTEM
          dstAccId: charge.srcAccId, // back to original payer (customer)
          refundedPaymentId: charge.id,
          idempotencyKey,
        },
        trx,
      );
      await trx.commit();
    } catch (err) {
      await trx.rollback();
      throw err;
    }

    // Talk to Kashier outside the trx. On Kashier accept (HTTP 2xx) we keep
    // the row in `pending` and wait for the webhook to flip it to succeeded.
    if (charge.method === TransactionMethod.ONLINE && charge.providerReferenceId) {
      try {
        const result = await this.kashier.refund({
          providerChargeId: charge.providerReferenceId,
          providerOrderId: charge.providerOrderId ?? undefined,
          amountMinor: requested,
          reason,
        });
        // Stamp Kashier's refund txn id so the webhook can find this row.
        await this.txRepo.updateStatus(region, refund.id, {
          status: TransactionStatus.PENDING,
          providerReferenceId: result.providerRefundId,
        });
        refund.providerReferenceId = result.providerRefundId;
      } catch (err) {
        this.logger.error(
          `kashier refund failed for charge ${charge.id}: ${
            (err as Error).message
          }`,
        );
        // Mark refund failed; don't roll back the row — admins can investigate.
        await this.txRepo.updateStatus(region, refund.id, {
          status: TransactionStatus.FAILED,
        });
        throw new ServiceUnavailableException(
          PAYMENT_ERRORS.PROVIDER_UNAVAILABLE,
        );
      }
    } else if (charge.method === TransactionMethod.COD) {
      // COD refunds are bookkeeping-only; mark succeeded immediately.
      await this.txRepo.updateStatus(region, refund.id, {
        status: TransactionStatus.SUCCEEDED,
      });
      refund.status = TransactionStatus.SUCCEEDED;
    }
    return refund;
  }

  // ─── helpers exposed to OrderService cross-module wiring ──────────────────
  async initForOrderEntity(
    actor: AuthenticatedUser,
    region: string,
    order: OrderEntity,
  ): Promise<PaymentSessionEntity> {
    const result = await this.init(actor, region, order.publicId);
    return result.session;
  }

  // Used by KashierWebhookService — kept here so the webhook service does not
  // need the provider repository.
  async findKashierProviderId(region: string): Promise<number> {
    const provider = await this.providerRepo.findByName(
      region,
      PaymentProviderName.KASHIER,
    );
    if (!provider) {
      // Fall back to the seeded literal so dev environments without the seed
      // still process webhooks (the unique constraint will catch duplicates).
      return PaymentProviderId.KASHIER;
    }
    return provider.id;
  }
}
