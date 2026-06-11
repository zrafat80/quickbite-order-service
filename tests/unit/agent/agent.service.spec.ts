import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AgentService } from 'src/app/agent/agent.service';
import { AgentEarningRepository } from 'src/app/agent/repository/agent-earning.repository';
import { OrderRepository } from 'src/app/order/repository/order.repository';
import { BranchClient } from 'src/lib/core-client/branch.client';

describe('AgentService', () => {
  const orders = {
    findByAgent: jest.fn(),
    findByPublicId: jest.fn(),
  };
  const earnings = {
    findByAgent: jest.fn(),
    sumByAgent: jest.fn(),
  };
  const branches = { getBranchesBulk: jest.fn() };
  const service = new AgentService(
    orders as unknown as OrderRepository,
    earnings as unknown as AgentEarningRepository,
    branches as unknown as BranchClient,
  );
  const params = {
    limit: 1,
    sortBy: 'created_at',
    apiSortBy: 'createdAt',
    sortOrder: 'desc' as const,
  };

  it('lists paginated tasks augmented with branch metadata', async () => {
    orders.findByAgent.mockResolvedValue([
      { id: 1, branchId: 5, createdAt: new Date() },
      { id: 2, branchId: 5, createdAt: new Date() },
    ]);
    branches.getBranchesBulk.mockResolvedValue([
      { id: 5, label: 'Downtown' },
    ]);

    await expect(
      service.listTasks('eg', 7, {
        status: undefined,
        filters: [],
        params,
      }),
    ).resolves.toMatchObject({
      data: [{ id: 1, branch: { id: 5, label: 'Downtown' } }],
      meta: { hasMore: true, count: 1 },
    });
    expect(branches.getBranchesBulk).toHaveBeenCalledWith([5]);
  });

  it('lists earnings with totals and an opaque cursor', async () => {
    const from = new Date('2026-06-01T00:00:00.000Z');
    const to = new Date('2026-06-08T00:00:00.000Z');
    earnings.findByAgent.mockResolvedValue([
      { id: 1, earnedAt: new Date('2026-06-07T00:00:00.000Z') },
      { id: 2, earnedAt: new Date('2026-06-06T00:00:00.000Z') },
    ]);
    earnings.sumByAgent.mockResolvedValue({
      sum: 3000,
      count: 2,
      currency: 'EGP',
    });

    await expect(
      service.listEarnings('eg', 7, { from, to, params }),
    ).resolves.toMatchObject({
      items: [{ id: 1 }],
      sum: 3000,
      count: 2,
      currency: 'EGP',
      from,
      to,
      nextCursor: expect.any(String),
    });
  });

  it('returns an order assigned to the agent', async () => {
    const order = { id: 1, deliveryAgentId: 7 };
    orders.findByPublicId.mockResolvedValue(order);
    await expect(
      service.assertAgentOwnership('eg', 'order-1', 7),
    ).resolves.toBe(order);
  });

  it('rejects missing or differently assigned orders', async () => {
    orders.findByPublicId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ id: 1, deliveryAgentId: 8 });
    await expect(
      service.assertAgentOwnership('eg', 'missing', 7),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.assertAgentOwnership('eg', 'order-1', 7),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
