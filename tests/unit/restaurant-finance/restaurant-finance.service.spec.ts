import { ConflictException } from '@nestjs/common';
import { TransactionMethod } from 'src/app/payment/enums';
import { TransactionRepository } from 'src/app/payment/repository/transaction.repository';
import { RestaurantBalanceRepository } from 'src/app/restaurant-finance/repository/restaurant-balance.repository';
import { RestaurantFinanceService } from 'src/app/restaurant-finance/restaurant-finance.service';
import { createShardedKnexMock } from '../helpers/test-doubles';

describe('RestaurantFinanceService', () => {
  const balanceRepository = {
    getBalance: jest.fn(),
    claimForUpdate: jest.fn(),
    incrementBalance: jest.fn(),
  };
  const transactionRepository = {
    findPayouts: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    create: jest.fn(),
  };
  const doubles = createShardedKnexMock();
  const service = new RestaurantFinanceService(
    doubles.knex,
    balanceRepository as unknown as RestaurantBalanceRepository,
    transactionRepository as unknown as TransactionRepository,
  );

  it('returns an existing balance or a zero balance object', async () => {
    const balance = {
      restaurantId: 5,
      region: 'eg',
      currency: 'EGP',
      balance: 4000,
    };
    balanceRepository.getBalance
      .mockResolvedValueOnce(balance)
      .mockResolvedValue(undefined);

    await expect(service.getBalance('eg', 5, 'EGP')).resolves.toBe(balance);
    await expect(service.getBalance('eg', 6, 'EGP')).resolves.toMatchObject({
      restaurantId: 6,
      region: 'eg',
      currency: 'EGP',
      balance: 0,
    });
  });

  it('delegates payout listing', async () => {
    const result = {
      data: [{ id: 1 }],
      meta: { nextCursor: null, hasMore: false, count: 1 },
    };
    transactionRepository.findPayouts.mockResolvedValue(result);
    await expect(
      service.listPayouts(
        'eg',
        5,
        new Date('2026-06-01'),
        new Date('2026-06-08'),
        {
          limit: 10,
          sortBy: 'id',
          apiSortBy: 'id',
          sortOrder: 'desc',
        },
      ),
    ).resolves.toBe(result);
  });

  it('replays an idempotent payout without opening a transaction', async () => {
    const existing = { id: 3 };
    transactionRepository.findByIdempotencyKey.mockResolvedValue(existing);
    await expect(
      service.recordPayout(
        'eg',
        5,
        {
          amount: 1000,
          currency: 'EGP',
          method: TransactionMethod.SYSTEM,
          dst: 'bank-account',
        },
        'payout-1',
      ),
    ).resolves.toBe(existing);
    expect(doubles.database.transaction).not.toHaveBeenCalled();
  });

  it('records and commits an affordable payout', async () => {
    transactionRepository.findByIdempotencyKey.mockResolvedValue(undefined);
    balanceRepository.claimForUpdate.mockResolvedValue({ balance: 5000 });
    transactionRepository.create.mockResolvedValue({ id: 4, amount: 1000 });

    await expect(
      service.recordPayout(
        'eg',
        5,
        {
          amount: 1000,
          currency: 'EGP',
          method: TransactionMethod.SYSTEM,
          dst: 'bank-account',
        },
        'payout-2',
      ),
    ).resolves.toMatchObject({ id: 4 });
    expect(balanceRepository.incrementBalance).toHaveBeenCalledWith(
      'eg',
      5,
      'EGP',
      -1000,
      doubles.transaction,
    );
    expect(doubles.transaction.commit).toHaveBeenCalled();
  });

  it('rolls back an overdraft or repository failure', async () => {
    transactionRepository.findByIdempotencyKey.mockResolvedValue(undefined);
    balanceRepository.claimForUpdate.mockResolvedValue({ balance: 500 });

    await expect(
      service.recordPayout('eg', 5, {
        amount: 1000,
        currency: 'EGP',
        method: TransactionMethod.SYSTEM,
        dst: 'bank-account',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(doubles.transaction.rollback).toHaveBeenCalled();
  });
});
