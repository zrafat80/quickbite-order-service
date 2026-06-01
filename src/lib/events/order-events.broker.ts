import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RabbitMQClient } from '../../pkg/messaging/rabbitmq/rabbitmq.client';

/**
 * Outbound publisher for `order.events`. Distinct from the inbound consumer's
 * connection so a publisher hiccup doesn't kill the consumer's channel.
 */
@Injectable()
export class OrderEventsBroker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OrderEventsBroker.name);
  private readonly client: RabbitMQClient;
  private readonly exchange: string;

  constructor(private readonly configService: ConfigService) {
    const url = this.configService.get<string>('rabbit.url');
    if (!url) {
      throw new Error('rabbit.url is not configured (set RABBITMQ_URL)');
    }
    this.client = new RabbitMQClient({
      url,
      reconnectInitialMs: 500,
      reconnectMaxMs: 15_000,
    });
    this.exchange =
      this.configService.get<string>('rabbit.orderEventsExchange') ?? 'order.events';
  }

  async onModuleInit() {
    try {
      await withTimeout(this.client.connect(), 5_000, 'order.events connect');
      // Declare exchange with a throw-away topology call (consume() is never invoked).
      await this.client.declareTopology({
        exchange: this.exchange,
        queue: 'order-events.declare-only',
        bindingKeys: [],
        prefetch: 1,
      });
      this.logger.log(`order.events publisher ready (exchange="${this.exchange}").`);
    } catch (err) {
      this.logger.warn(
        `RabbitMQ unreachable at boot — drains will retry. ${(err as Error).message}`,
      );
    }
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`Closing order.events connection (${signal ?? 'shutdown'})…`);
    await this.client.close();
  }

  async ensureConnected(): Promise<void> {
    await this.client.connect();
  }

  async publish(routingKey: string, body: Buffer): Promise<void> {
    await this.client.publish(this.exchange, routingKey, body);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
