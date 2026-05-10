import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RabbitMQClient } from '../../pkg/messaging/rabbitmq/rabbitmq.client';
import type { IMessageBroker } from '../../pkg/messaging/message-broker.interface';

/**
 * Single shared AMQP connection. The underlying client uses
 * amqp-connection-manager — connect/close are lifecycle hooks here, but
 * reconnects are automatic if the broker bounces.
 *
 * Boot is best-effort: a broker outage at startup must not crash the API.
 * `getBroker()` exposes the client to the core-events consumer; the consumer's
 * own `OnModuleInit` declares topology and starts consuming.
 */
@Injectable()
export class AmqpConnection implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AmqpConnection.name);
  private readonly client: RabbitMQClient;

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
  }

  async onModuleInit() {
    try {
      await withTimeout(this.client.connect(), 5_000, 'RabbitMQ connect');
      this.logger.log('Connected to RabbitMQ.');
    } catch (err) {
      this.logger.warn(
        `RabbitMQ unreachable at boot — will reconnect in background. ${(err as Error).message}`,
      );
    }
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`Closing RabbitMQ connection (${signal ?? 'shutdown'})…`);
    await this.client.close();
  }

  getBroker(): IMessageBroker {
    return this.client;
  }
}

/**
 * Race a promise against a timeout. amqp-connection-manager retries forever
 * by design, so `await client.connect()` never rejects when the broker is
 * down. We bound it here so the API can boot best-effort without a broker.
 */
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
