import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderRepository } from './repository/order.repository';
import { OrderItemRepository } from './repository/order-item.repository';
import { OrderStatusService } from './order-status.service';
import { AssignmentService } from './assignment.service';
import { PaymentModule } from '../payment/payment.module';
import { PresenceModule } from '../presence/presence.module';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [
    forwardRef(() => PaymentModule),
    forwardRef(() => PresenceModule),
    forwardRef(() => AgentModule),
  ],
  controllers: [OrderController],
  providers: [
    OrderService,
    OrderStatusService,
    OrderRepository,
    OrderItemRepository,
    AssignmentService,
  ],
  exports: [OrderService, OrderRepository, AssignmentService],
})
export class OrderModule implements OnModuleInit {
  constructor(
    private readonly orderService: OrderService,
    private readonly assignmentService: AssignmentService,
  ) {}

  onModuleInit() {
    // Wire up the lazy reference so OrderService can trigger auto-assignment
    // without a direct import (avoids circular dependency).
    this.orderService.setAssignmentService(this.assignmentService);
  }
}
