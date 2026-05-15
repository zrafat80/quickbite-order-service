import { Module } from '@nestjs/common';
import { RestaurantFinanceController } from './restaurant-finance.controller';
import { RestaurantFinanceService } from './restaurant-finance.service';
import { RestaurantBalanceRepository } from './repository/restaurant-balance.repository';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [PaymentModule], // For TransactionRepository
  controllers: [RestaurantFinanceController],
  providers: [RestaurantFinanceService, RestaurantBalanceRepository],
  exports: [RestaurantFinanceService, RestaurantBalanceRepository],
})
export class RestaurantFinanceModule {}
