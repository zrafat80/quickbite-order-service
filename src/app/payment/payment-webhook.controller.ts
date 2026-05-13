import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { KashierWebhookService } from './kashier-webhook.service';
import { PROVIDER_NAMES } from './dto/payment.response.dto';
import { PaymentProviderName } from './enums';

/**
 * Webhook endpoints land here — no JwtAuthGuard. Auth is provider-specific
 * and is verified inside the service (HMAC for Kashier).
 */
@Controller('payments/webhook')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(private readonly kashierWebhook: KashierWebhookService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: Request,
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; alreadyProcessed?: boolean }> {
    if (!PROVIDER_NAMES.includes(provider)) {
      throw new BadRequestException(`Unknown payment provider: ${provider}`);
    }
    if (provider === PaymentProviderName.COD) {
      // COD has no provider webhook today.
      return { ok: true };
    }
    if (provider !== PaymentProviderName.KASHIER) {
      return { ok: true };
    }

    // The webhook signature is computed over the alphabetized signatureKeys
    // values, NOT over the raw body, so re-stringifying the parsed body is
    // safe. We pass the parsed body string for verifyWebhook's JSON.parse.
    const rawBody = JSON.stringify(req.body ?? {});
    return this.kashierWebhook.handle(headers, rawBody);
  }
}
