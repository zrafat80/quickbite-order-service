import {
  Body,
  Controller,
  Get, Head, Header,
  Param,
    Headers,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../lib/middleware/guards/jwtGuard';
import { IdempotencyInterceptor } from '../../lib/idempotency/idempotency.interceptor';
import { Idempotency } from '../../lib/idempotency/idempotency.decorator';
import { InitPaymentRequestDTO } from './dto/init-payment.request.dto';
import { RefundRequestDTO } from './dto/refund.request.dto';
import {
  PaymentInitResponseDTO,
  PaymentResponseDTO,
  RefundResponseDTO,
} from './dto/payment.response.dto';
import { PaymentService } from './payment.service';

@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // ─── POST /payments/init ──────────────────────────────────────────────────
  @Post('init')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotency({ strict: true })
  async init(
    @Req() req: Request,
    @Body() body: InitPaymentRequestDTO,
  ): Promise<PaymentInitResponseDTO> {
    const region = req.region ?? '';
    const result = await this.paymentService.init(
      req.user!,
      region,
      body.orderId,
    );
    return PaymentInitResponseDTO.from(result.session, result.order.publicId);
  }

  // ─── GET /payments/:id ────────────────────────────────────────────────────
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getPayment(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PaymentResponseDTO> {
    const region = req.region ?? '';
    const { tx, order, providerName } = await this.paymentService.getById(
      req.user!,
      region,
      id,
    );
    return PaymentResponseDTO.from(
      tx,
      order?.publicId ?? null,
      providerName,
    );
  }

  // ─── POST /payments/:id/refund ────────────────────────────────────────────
  @Post(':id/refund')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotency({ strict: true })
  async refund(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: RefundRequestDTO,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<RefundResponseDTO> {
    const region = req.region ?? '';
    const refund = await this.paymentService.refund(
      req.user!,
      region,
      id,
      body,
        idempotencyKey,
    );
    return RefundResponseDTO.from(refund);
  }
}
