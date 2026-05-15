import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { ShardedKnex } from '../../lib/sharding/shards';
import { RestaurantBalanceRepository } from './repository/restaurant-balance.repository';
import { TransactionRepository } from '../payment/repository/transaction.repository';
import { CreatePayoutRequestDTO } from './dto/restaurant-finance.request.dto';
import { RestaurantBalanceEntity } from './entity/restaurant-balance.entity';
import { TransactionEntity } from '../payment/entity/transaction.entity';
import { PaginationParams, PaginationMeta } from '../../lib/pagination/cursor-pagination';
import { TransactionMethod, TransactionStatus, TransactionType } from '../payment/enums';

@Injectable()
export class RestaurantFinanceService {
  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    private readonly balanceRepo: RestaurantBalanceRepository,
    private readonly transactionRepo: TransactionRepository,
  ) {}

  async getBalance(
    region: string,
    restaurantId: number,
    currency: string,
  ): Promise<RestaurantBalanceEntity> {
    const balance = await this.balanceRepo.getBalance(region, restaurantId, currency);
    if (!balance) {
      // If not exists, return a 0 balance object instead of null for easy reading
      return new RestaurantBalanceEntity({
        restaurantId,
        region,
        currency,
        balance: 0,
        updatedAt: new Date(),
      });
    }
    return balance;
  }

  async listPayouts(
    region: string,
    restaurantId: number,
    from: Date,
    to: Date,
    params: PaginationParams,
  ): Promise<{ data: TransactionEntity[]; meta: PaginationMeta }> {
    return this.transactionRepo.findPayouts(region, restaurantId, from, to, params);
  }

  async recordPayout(
    region: string,
    restaurantId: number,
    input: CreatePayoutRequestDTO,
    idempotencyKey?: string,
  ): Promise<TransactionEntity> {
    if (idempotencyKey) {
      const existing = await this.transactionRepo.findByIdempotencyKey(region, idempotencyKey);
      if (existing) return existing;
    }

    const trx = await this.knex.db(region).transaction();
    try {
      // Lock the balance row to ensure we don't overdraft
      const balanceEntity = await this.balanceRepo.claimForUpdate(
        region,
        restaurantId,
        input.currency,
        trx,
      );

      if (balanceEntity.balance < input.amount) {
        throw new ConflictException('InsufficientBalance');
      }

      // Deduct from balance
      await this.balanceRepo.incrementBalance(
        region,
        restaurantId,
        input.currency,
        -input.amount,
        trx,
      );

      // Record transaction
      const payout = await this.transactionRepo.create(
        region,
        {
          region,
          orderId: null,
          orderCreatedAt: null,
          transactionType: TransactionType.PAYOUT,
          method: input.method as TransactionMethod,
          providerId: null,
          providerReferenceId: null,
          status: TransactionStatus.SUCCEEDED,
          amount: input.amount,
          currency: input.currency,
          srcAccId: restaurantId,
          dstAccId: null,
          idempotencyKey: idempotencyKey ?? null,
        },
        trx,
      );

      await trx.commit();
      return payout;
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }
}
