import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { RequireInternalApiKeyGuard } from '../../lib/middleware/guards/internal-api-key.guard';
import { PaymentSessionSweeperWorker } from './jobs/payment-session-sweeper.worker';

/**
 * Internal-only operations on payments. Routes are protected by the shared
 * `x-api-key` header (matches core's `INTERNAL_API_KEY`).
 *
 * Today only the sweeper trigger lives here — it's used by ops and by E2E
 * tests to force a sweep instead of waiting for the @Cron tick.
 */
@Controller('payments/internal')
@UseGuards(RequireInternalApiKeyGuard)
export class PaymentInternalController {
  constructor(
    private readonly sweeper: PaymentSessionSweeperWorker,
    private readonly configService: ConfigService,
  ) {}

  @Post('sweeper/run')
  async runSweeper(
    @Req() req: Request,
  ): Promise<{
    region: string;
    sessionsExpired: number;
    ordersCancelled: number;
  }> {
    const region = req.region ?? 'eg';
    const graceMinutes =
      this.configService.get<number>('kashier.paymentSessionTimeoutMin') ?? 15;
    const result = await this.sweeper.sweepRegion(region, graceMinutes);
    return { region, ...result };
  }
}
