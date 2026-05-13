import { OrderEntity } from '../order/entity/order.entity';
import { PaymentSessionEntity } from './entity/payment-session.entity';

export interface InitPaymentResult {
  session: PaymentSessionEntity;
  order: OrderEntity;
}

export interface AuthenticatedUser {
  userId: number;
  role: string;
  restaurantId?: number;
  restaurantRole?: string;
  branchIds?: number[];
}
