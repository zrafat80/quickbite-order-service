import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { ShardedKnex } from '../../../lib/sharding/shards';
import { OrderService } from '../../order/order.service';
import { PaymentSessionRepository } from '../repository/payment-session.repository';

/**
 * Closes the loop on online orders whose Kashier session never resolved.
 *
 * Every minute, per region:
 *   1. Flip payment_sessions where status IN (initialized, pending, authorized)
 *      and expires_at < NOW() to 'expired'. Status hygiene — the read query
 *      already ignores them, but a final state makes dashboards honest.
 *   2. Find orders still in `pending_payment` past the grace window
 *      (order.created_at + PAYMENT_SESSION_TIMEOUT_MIN minutes) with NO active
 *      session, and transition them to `cancelled`.
 *
 * The grace window matches one full session lifetime, so a customer who
 * paid late or retried right before expiry is never killed mid-flight: as
 * long as they have a live (non-expired) session, they're skipped.
 */
@Injectable()
export class PaymentSessionSweeperWorker {
  private readonly logger = new Logger(PaymentSessionSweeperWorker.name);
  private running = false;

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly sessionRepo: PaymentSessionRepository,
    @Inject(forwardRef(() => OrderService))
    private readonly orderService: OrderService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('previous tick still running; skipping');
      return;
    }
    this.running = true;
    try {
      const graceMinutes =
        this.configService.get<number>('kashier.paymentSessionTimeoutMin') ?? 15;
      for (const region of this.knex.regions()) {
        await this.sweepRegion(region, graceMinutes);
      }
    } finally {
      this.running = false;
    }
  }

  async sweepRegion(region: string, graceMinutes: number): Promise<{
    sessionsExpired: number;
    ordersCancelled: number;
  }> {
    const trx: Knex.Transaction = await this.knex.db(region).transaction();
    let sessionsExpired = 0;
    let ordersCancelled = 0;

    try {
      sessionsExpired = await this.sessionRepo.expireStaleSessions(region, trx);

      const candidates = await this.orderService.findExpirablePendingPayment(
          region,
          graceMinutes,
          500,
      );

      // NO MORE FOR-LOOP! We pass all candidates straight to the bulk update
      if (candidates.length > 0) {
        ordersCancelled = await this.orderService.bulkCancelExpiredOrders(
            region,
            candidates,
            trx
        );

        if (ordersCancelled > 0) {
          this.logger.log(
              `swept ${ordersCancelled} abandoned orders -> cancelled (region=${region})`,
          );
        }
      }

      await trx.commit();
    } catch (err) {
      await trx.rollback();
      this.logger.error(
          `sweep failed for region ${region}: ${(err as Error).message}`,
      );
      throw err;
    }

    if (sessionsExpired > 0 || ordersCancelled > 0) {
      this.logger.log(
          `region=${region} sessionsExpired=${sessionsExpired} ordersCancelled=${ordersCancelled}`,
      );
    }
    return { sessionsExpired, ordersCancelled };
  }
}
