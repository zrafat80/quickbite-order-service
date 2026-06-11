import { RestaurantBalanceRepository } from 'src/app/restaurant-finance/repository/restaurant-balance.repository';
import { createShardedKnexMock } from '../helpers/test-doubles';

describe('RestaurantBalanceRepository', () => {
  const row = {
    id: '1',
    region: 'eg',
    restaurant_id: '5',
    currency: 'EGP',
    balance: '4000',
    updated_at: new Date(),
  };

  it('loads balances or returns null', async () => {
    const doubles = createShardedKnexMock();
    const repository = new RestaurantBalanceRepository(doubles.knex);
    doubles.query.first.mockResolvedValueOnce(row).mockResolvedValue(undefined);

    await expect(repository.getBalance('eg', 5, 'EGP')).resolves.toMatchObject({
      restaurantId: 5,
      balance: 4000,
    });
    await expect(repository.getBalance('eg', 6, 'EGP')).resolves.toBeNull();
  });

  it('increments balances through the upsert query', async () => {
    const doubles = createShardedKnexMock();
    const repository = new RestaurantBalanceRepository(doubles.knex);
    doubles.database.raw.mockResolvedValue({ rows: [row] });

    await expect(
      repository.incrementBalance('eg', 5, 'EGP', -1000),
    ).resolves.toMatchObject({ balance: 4000 });
    expect(doubles.database.raw).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT'),
      ['eg', 5, 'EGP', -1000],
    );
  });

  it('upserts and locks balances for payout updates', async () => {
    const doubles = createShardedKnexMock();
    const repository = new RestaurantBalanceRepository(doubles.knex);
    doubles.transaction.raw.mockResolvedValue({ rows: [row] });
    doubles.query.first.mockResolvedValue(row);

    await expect(
      repository.claimForUpdate(
        'eg',
        5,
        'EGP',
        doubles.transaction as never,
      ),
    ).resolves.toMatchObject({ restaurantId: 5, balance: 4000 });
    expect(doubles.query.forUpdate).toHaveBeenCalled();
  });
});
