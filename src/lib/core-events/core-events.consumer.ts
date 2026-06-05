import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ConsumeMessage,
  ConsumerOptions,
} from '../../pkg/messaging/message-broker.interface';
import {
  REDIS_CACHE_PROVIDER,
} from '../cache/redis.module';
import type { ICacheProvider } from '../../pkg/cache/cache.interface';
import { AmqpConnection } from '../messaging/amqp.connection';
import { HandlerRegistryService } from './handler-registry.service';
import { CoreEventEnvelope } from './types';

/**
 * Inbound consumer of `core.events`. Lifecycle:
 *   1. Declare topology (exchange, durable queue with DLX args, bindings, DLQ).
 *   2. Start consuming with manual ack.
 *   3. Per message:
 *        - Dedupe via Redis SETNX `core-events:dedupe:<eventId>` (24h TTL).
 *        - If duplicate → ack and skip.
 *        - Lookup handler. If none → log "no handler, acking" and ack
 *          (unknown event types are NOT poison; they are forward-compat).
 *        - Run handler. Success → ack. Throw → nack(requeue=false) → DLQ.
 *
 * Boot is best-effort: a broker outage at startup must not crash the API.
 * amqp-connection-manager will reconnect and re-declare topology; consumer
 * resubscribes automatically because the channel-wrapper replays setup.
 */
const DEDUPE_TTL_SEC = 24 * 60 * 60;

@Injectable()
export class CoreEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(CoreEventsConsumer.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly amqp: AmqpConnection,
    private readonly registry: HandlerRegistryService,
    @Inject(REDIS_CACHE_PROVIDER) private readonly cache: ICacheProvider,
  ) {}

  async onModuleInit() {
    const topology: ConsumerOptions = {
      exchange: this.configService.get<string>('rabbit.exchange') ?? 'core.events',
      alternateExchange:
        this.configService.get<string>('rabbit.alternateExchange') ??
        'core.events.unroutable',
      alternateQueue:
        this.configService.get<string>('rabbit.alternateQueue') ??
        'core.events.unroutable.dlq',
      queue:
        this.configService.get<string>('rabbit.queue') ??
        'order-service.core-events',
      bindingKeys: this.configService.get<string[]>('rabbit.bindings') ?? [],
      deadLetterExchange:
        this.configService.get<string>('rabbit.dlx') ?? 'core.events.dlx',
      deadLetterQueue:
        this.configService.get<string>('rabbit.dlq') ??
        'order-service.core-events.dlq',
      prefetch: this.configService.get<number>('rabbit.prefetch') ?? 32,
    };

    try {
      const broker = this.amqp.getBroker();
      await withTimeout(
        (async () => {
          await broker.declareTopology(topology);
          await broker.consume(topology, (msg) => this.handle(msg));
        })(),
        5_000,
        'core-events declareTopology+consume',
      );
      this.logger.log(
        `consumer started (queue="${topology.queue}", bindings=[${topology.bindingKeys.join(',')}])`,
      );
    } catch (err) {
      // Don't crash the API on broker unreachability — amqp-connection-manager
      // retries forever in the background. Once Rabbit is back the channel
      // setup replays automatically, but the consumer is not re-armed
      // here — Phase 1+ can add a retry loop if we ever hit this in prod.
      this.logger.warn(
        `failed to start consumer at boot: ${(err as Error).message}`,
      );
    }
  }

  private async handle(msg: ConsumeMessage): Promise<void> {
    const envelope = parseEnvelope(msg);
    if (!envelope) {
      this.logger.warn('rejecting unparseable message');
      return msg.nack(false);
    }

    const fresh = await this.cache.trySet(
      `core-events:dedupe:${envelope.eventId}`,
      '1',
      DEDUPE_TTL_SEC,
    );
    if (!fresh) {
      msg.ack();
      return;
    }

    const handler = this.registry.get(envelope.eventType);
    if (!handler) {
      this.logger.warn(
        `no handler, acking (eventType=${envelope.eventType}, eventId=${envelope.eventId})`,
      );
      msg.ack();
      return;
    }

    try {
      await handler(envelope.payload);
      msg.ack();
    } catch (err) {
      this.logger.error(
        `handler failed, sending to DLQ (eventType=${envelope.eventType}, eventId=${envelope.eventId}): ${(err as Error).message}`,
      );
      msg.nack(false);
    }
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

function parseEnvelope(msg: ConsumeMessage): CoreEventEnvelope | null {
  try {
    const env = JSON.parse(msg.body.toString('utf8')) as CoreEventEnvelope;
    if (!env.eventId || !env.eventType) return null;
    return env;
  } catch {
    return null;
  }
}
