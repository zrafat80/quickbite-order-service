import { RestaurantBalanceEntity } from '../entity/restaurant-balance.entity';
import { TransactionEntity } from '../../payment/entity/transaction.entity';

export class RestaurantBalanceResponseDTO {
  restaurantId!: string;
  currency!: string;
  balance!: number;
  updatedAt!: string;

  static from(entity: RestaurantBalanceEntity): RestaurantBalanceResponseDTO {
    const dto = new RestaurantBalanceResponseDTO();
    dto.restaurantId = entity.restaurantId.toString();
    dto.currency = entity.currency;
    dto.balance = entity.balance;
    dto.updatedAt = entity.updatedAt.toISOString();
    return dto;
  }
}

export class PayoutResponseDTO {
  id!: string;
  amount!: number;
  currency!: string;
  status!: string;
  method!: string;
  src!: string | null;
  dst!: string | null;
  createdAt!: string;

  static from(entity: TransactionEntity): PayoutResponseDTO {
    const dto = new PayoutResponseDTO();
    dto.id = entity.id.toString();
    dto.amount = entity.amount;
    dto.currency = entity.currency;
    dto.status = entity.status;
    dto.method = entity.method;
    dto.src = entity.srcAccId ? entity.srcAccId.toString() : null;
    dto.dst = entity.dstAccId ? entity.dstAccId.toString() : null;
    dto.createdAt = entity.createdAt.toISOString();
    return dto;
  }
}
