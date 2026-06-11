import { AgentEarningRepository } from 'src/app/agent/repository/agent-earning.repository';
import { createShardedKnexMock } from '../helpers/test-doubles';

describe('AgentEarningRepository', () => {
  const row = {
    id: '1',
    region: 'eg',
    agent_id: '7',
    order_id: '4',
    order_created_at: new Date(),
    amount: '1200',
    currency: 'EGP',
    earned_at: new Date('2026-06-07T10:00:00.000Z'),
    order_public_id: 'order-1',
  };

  it('inserts earnings idempotently', async () => {
    const doubles = createShardedKnexMock();
    const repository = new AgentEarningRepository(doubles.knex);
    doubles.database.raw
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.insertIdempotent('eg', {
        region: 'eg',
        agentId: 7,
        orderId: 4,
        orderCreatedAt: row.order_created_at,
        amount: 1200,
        currency: 'EGP',
      }),
    ).resolves.toMatchObject({ id: 1, amount: 1200 });
    await expect(
      repository.insertIdempotent('eg', {
        region: 'eg',
        agentId: 7,
        orderId: 4,
        orderCreatedAt: row.order_created_at,
        amount: 1200,
        currency: 'EGP',
      }),
    ).resolves.toBeNull();
  });

  it('lists augmented earnings with filters and cursor pagination', async () => {
    const doubles = createShardedKnexMock();
    const repository = new AgentEarningRepository(doubles.knex);
    doubles.setResult([row]);

    await expect(
      repository.findByAgent(
        'eg',
        7,
        [{ field: 'ae.earned_at', operator: 'gte', value: '2026-06-01' }],
        {
          limit: 10,
          sortBy: 'earned_at',
          apiSortBy: 'earnedAt',
          sortOrder: 'desc',
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 1,
        agentId: 7,
        orderPublicId: 'order-1',
      }),
    ]);
  });

  it('returns normalized earning totals', async () => {
    const doubles = createShardedKnexMock();
    const repository = new AgentEarningRepository(doubles.knex);
    doubles.query.first
      .mockResolvedValueOnce({ sum: '3000', count: '2', currency: 'EGP' })
      .mockResolvedValueOnce(undefined);

    await expect(
      repository.sumByAgent(
        'eg',
        7,
        new Date('2026-06-01'),
        new Date('2026-06-08'),
      ),
    ).resolves.toEqual({ sum: 3000, count: 2, currency: 'EGP' });
    await expect(
      repository.sumByAgent(
        'eg',
        8,
        new Date('2026-06-01'),
        new Date('2026-06-08'),
      ),
    ).resolves.toEqual({ sum: 0, count: 0, currency: 'EGP' });
  });
});
