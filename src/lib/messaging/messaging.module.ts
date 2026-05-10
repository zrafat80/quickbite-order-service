import { Global, Module } from '@nestjs/common';
import { AmqpConnection } from './amqp.connection';

/**
 * Owns the single shared AMQP connection. Consumers/publishers in other
 * modules (core-events, future outbound publishers) inject `AmqpConnection`
 * and call `getBroker()` to access the underlying `IMessageBroker`.
 */
@Global()
@Module({
  providers: [AmqpConnection],
  exports: [AmqpConnection],
})
export class MessagingModule {}
