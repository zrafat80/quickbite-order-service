import { forwardRef, Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderRepository } from './repository/order.repository';
import { OrderItemRepository } from './repository/order-item.repository';
import { OrderStatusService } from './order-status.service';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [forwardRef(() => PaymentModule)],
  controllers: [OrderController],
  providers: [
    OrderService,
    OrderStatusService,
    OrderRepository,
    OrderItemRepository,
  ],
  exports: [OrderService],
})
export class OrderModule {}
