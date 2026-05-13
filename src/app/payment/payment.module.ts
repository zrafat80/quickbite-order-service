import { forwardRef, Module } from '@nestjs/common';
import { OrderModule } from '../order/order.module';
import { PaymentController } from './payment.controller';
import { PaymentInternalController } from './payment.internal.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentService } from './payment.service';
import { KashierWebhookService } from './kashier-webhook.service';
import { KashierProviderService } from './kashier-provider.service';
import { PaymentSessionRepository } from './repository/payment-session.repository';
import { TransactionRepository } from './repository/transaction.repository';
import { PaymentProviderRepository } from './repository/payment-provider.repository';
import { PaymentWebhookEventRepository } from './repository/payment-webhook-event.repository';
import { PaymentSessionSweeperWorker } from './jobs/payment-session-sweeper.worker';

@Module({
  imports: [forwardRef(() => OrderModule)],
  controllers: [
    PaymentController,
    PaymentInternalController,
    PaymentWebhookController,
  ],
  providers: [
    PaymentService,
    KashierWebhookService,
    KashierProviderService,
    PaymentSessionRepository,
    TransactionRepository,
    PaymentProviderRepository,
    PaymentWebhookEventRepository,
    PaymentSessionSweeperWorker,
  ],
  exports: [PaymentService],
})
export class PaymentModule {}
