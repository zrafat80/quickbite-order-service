import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../lib/middleware/guards/jwtGuard';
import { PermissionsGuard } from '../../lib/middleware/guards/permissions.guard';
import { RequirePermissions } from '../../lib/decorators/permissions.decorator';
import { RestaurantMemberGuard } from '../../lib/middleware/guards/restaurant-member.guard';
import { IdempotencyInterceptor } from '../../lib/idempotency/idempotency.interceptor';
import { Idempotency } from '../../lib/idempotency/idempotency.decorator';
import { RestaurantFinanceService } from './restaurant-finance.service';
import { parsePaginationQuery } from '../../lib/pagination/query-parser';
import { CreatePayoutRequestDTO } from './dto/restaurant-finance.request.dto';
import { PayoutResponseDTO, RestaurantBalanceResponseDTO } from './dto/restaurant-finance.response.dto';

@Controller('restaurants/:restaurantId')
@UseGuards(JwtAuthGuard, PermissionsGuard, RestaurantMemberGuard)
export class RestaurantFinanceController {
  constructor(private readonly financeService: RestaurantFinanceService) {}

  @Get('balance')
  @RequirePermissions('finance', 'read')
  async getBalance(
    @Req() req: Request,
    @Param('restaurantId', ParseIntPipe) restaurantId: number,
    @Query('currency') currency: string,
  ) {
    const region = req.region!;
    const cur = currency || 'EGP'; // Default or require it
    const balance = await this.financeService.getBalance(region, restaurantId, cur);
    return RestaurantBalanceResponseDTO.from(balance);
  }

  @Get('payouts')
  @RequirePermissions('finance', 'read')
  async listPayouts(
    @Req() req: Request,
    @Param('restaurantId', ParseIntPipe) restaurantId: number,
  ) {
    const region = req.region!;
    
    const now = new Date();
    const from = req.query.from
      ? new Date(req.query.from as string)
      : new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    const to = req.query.to ? new Date(req.query.to as string) : now;

    const params = parsePaginationQuery(
      { ...req.query, sortBy: 'createdAt', sortOrder: 'desc' },
      { createdAt: 'created_at' },
    );

    const result = await this.financeService.listPayouts(region, restaurantId, from, to, params);
    
    return {
      data: result.data.map(PayoutResponseDTO.from),
      meta: result.meta,
    };
  }

  @Post('payouts')
  @RequirePermissions('finance', 'payout_create', true) // Admin only or specific roles
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotency({ strict: true })
  async recordPayout(
    @Req() req: Request,
    @Param('restaurantId', ParseIntPipe) restaurantId: number,
    @Body() body: CreatePayoutRequestDTO,
  ) {
    const region = req.region!;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    const payout = await this.financeService.recordPayout(
      region,
      restaurantId,
      body,
      idempotencyKey,
    );

    return PayoutResponseDTO.from(payout);
  }
}
