import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KashierClient } from '../../pkg/payments/kashier/kashier.client';
import { KashierClientConfig } from '../../pkg/payments/kashier/kashier.types';

/**
 * NestJS-side wrapper around the framework-agnostic KashierClient. Reads the
 * provider config from `ConfigService` once at startup and exposes the same
 * IPaymentProvider surface to the rest of the module.
 *
 * Kept thin on purpose — all real logic lives in `pkg/payments/kashier/*`.
 */
@Injectable()
export class KashierProviderService extends KashierClient {
  private static readonly logger = new Logger(KashierProviderService.name);

  constructor(configService: ConfigService) {
    const cfg: KashierClientConfig = {
      baseUrl: configService.get<string>('kashier.baseUrl') ?? '',
      fepUrl: configService.get<string>('kashier.fepUrl') ?? '',
      merchantId: configService.get<string>('kashier.merchantId') ?? '',
      apiKey: configService.get<string>('kashier.apiKey') ?? '',
      secretKey: configService.get<string>('kashier.secretKey') ?? '',
      webhookSecret: configService.get<string>('kashier.webhookSecret') ?? '',
      paymentSessionTimeoutMin:
        configService.get<number>('kashier.paymentSessionTimeoutMin') ?? 15,
    };
    super(cfg);
    if (!cfg.merchantId || !cfg.apiKey || !cfg.secretKey) {
      KashierProviderService.logger.warn(
        'Kashier credentials incomplete; init/refund/webhook calls will fail.',
      );
    }
  }
}
