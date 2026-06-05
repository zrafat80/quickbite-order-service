import amqp from 'amqp-connection-manager';
import type {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import type {
  ConfirmChannel,
  ConsumeMessage as AmqpConsumeMessage,
} from 'amqplib';
import type {
  ConsumeMessage,
  ConsumerOptions,
  IMessageBroker,
} from '../message-broker.interface';
import type { RabbitMQConfig } from './rabbitmq.types';

/**
 * Mental model
 * ------------
 *   - 1 TCP connection -> many cheap virtual "channels".
 *   - Each channel here is a ChannelWrapper: it auto-reconnects and replays
 *     its `setup(ch)` function every time the underlying channel reopens.
 *   - We keep ONE long-lived publisher channel and open extra channels for
 *     declaring topology and for consuming. One channel = one purpose.
 */
export class RabbitMQClient implements IMessageBroker {
  private connection: AmqpConnectionManager | null = null;
  private publishChannel: ChannelWrapper | null = null;

  constructor(private readonly config: RabbitMQConfig) {}

  async connect(): Promise<void> {
    if (this.connection) return;

    const reconnectSec = Math.max(
      1,
      Math.round(this.config.reconnectInitialMs / 1000),
    );
    this.connection = amqp.connect([this.config.url], {
      reconnectTimeInSeconds: reconnectSec,
    });

    this.publishChannel = this.connection.createChannel({
      json: false,
      setup: async (_ch: ConfirmChannel) => {
        /* publisher channel needs no setup */
      },
    });
    await this.publishChannel.waitForConnect();
  }

  async close(): Promise<void> {
    await this.publishChannel?.close().catch(() => {});
    await this.connection?.close().catch(() => {});
    this.publishChannel = null;
    this.connection = null;
  }

  async declareTopology(opts: ConsumerOptions): Promise<void> {
    await this.connect();
    const ch = this.connection!.createChannel({
      json: false,
      setup: (c: ConfirmChannel) => assertTopology(c, opts),
    });
    await ch.waitForConnect();
    await ch.close();
  }

  async consume(
    opts: ConsumerOptions,
    handler: (msg: ConsumeMessage) => Promise<void>,
  ): Promise<void> {
    await this.connect();
    const ch = this.connection!.createChannel({
      json: false,
      setup: async (c: ConfirmChannel) => {
        await assertTopology(c, opts);
        await c.prefetch(opts.prefetch);
        await c.consume(
          opts.queue,
          (raw) => handleMessage(c, raw, handler),
          { noAck: false }, // no auto acknowledgement
        );
      },
    });
    await ch.waitForConnect();
  }

  async publish(exchange: string, routingKey: string, body: Buffer): Promise<void> {
    await this.connect();
    await this.publishChannel!.publish(exchange, routingKey, body, {
      persistent: true,
      contentType: 'application/json',
    });
  }
}

// "assert" = create if missing, else verify settings match. Always idempotent.
async function assertTopology(ch: ConfirmChannel, opts: ConsumerOptions): Promise<void> {
  if (opts.alternateExchange && opts.alternateQueue) {
    await ch.assertExchange(opts.alternateExchange, 'fanout', {
      durable: true,
    });
    await ch.assertQueue(opts.alternateQueue, { durable: true });
    await ch.bindQueue(opts.alternateQueue, opts.alternateExchange, '');
  }

  await ch.assertExchange(opts.exchange, 'topic', {
    durable: true,
    arguments: opts.alternateExchange
      ? { 'alternate-exchange': opts.alternateExchange }
      : undefined,
  });

  if (opts.deadLetterExchange && opts.deadLetterQueue) {
    await ch.assertExchange(opts.deadLetterExchange, 'topic', { durable: true });
    await ch.assertQueue(opts.deadLetterQueue, { durable: true });
    await ch.bindQueue(opts.deadLetterQueue, opts.deadLetterExchange, '#');
  }

  const queueArgs: Record<string, string> = {};
  if (opts.deadLetterExchange) {
    queueArgs['x-dead-letter-exchange'] = opts.deadLetterExchange;
  }

  await ch.assertQueue(opts.queue, { durable: true, arguments: queueArgs });
  for (const key of opts.bindingKeys) {
    await ch.bindQueue(opts.queue, opts.exchange, key);
  }
}

async function handleMessage(
  ch: ConfirmChannel,
  raw: AmqpConsumeMessage | null,
  handler: (msg: ConsumeMessage) => Promise<void>,
): Promise<void> {
  if (!raw) return; // null = consumer cancelled by the broker

  const msg: ConsumeMessage = {
    routingKey: raw.fields.routingKey,
    body: raw.content,
    ack: () => ch.ack(raw),
    nack: (requeue = false) => ch.nack(raw, false, requeue),
  };

  try {
    await handler(msg);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[rabbitmq] handler threw:', (err as Error).message);
    msg.nack(false);
  }
}
