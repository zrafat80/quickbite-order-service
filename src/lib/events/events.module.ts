import { Global, Module } from '@nestjs/common';
import { OutboxRepository } from './outbox.repository';
import { OutboxDrainService } from './outbox-drain.service';
import { OrderEventsBroker } from './order-events.broker';

/**
 * Outbound events: outbox repo (service-layer writes) + drain service
 * (scheduled @Cron). Global so OrderService can `@Inject(OutboxRepository)`
 * without importing this module explicitly.
 */
@Global()
@Module({
  providers: [OutboxRepository, OutboxDrainService, OrderEventsBroker],
  exports: [OutboxRepository, OutboxDrainService, OrderEventsBroker],
})
export class EventsModule {}
