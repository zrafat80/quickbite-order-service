import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PresenceService } from 'src/app/agent/presence.service';
import { AgentPresenceRepository } from 'src/app/agent/repository/agent-presence.repository';
import { OrderRepository } from 'src/app/order/repository/order.repository';
import { createRedisMock, createShardedKnexMock } from '../helpers/test-doubles';

describe('PresenceService', () => {
  const presenceRepository = {
    upsertOnline: jest.fn(),
    updateOffline: jest.fn(),
    updatePing: jest.fn(),
  };
  const orderRepository = { findActiveByAgent: jest.fn() };
  let redis: ReturnType<typeof createRedisMock>;
  let service: PresenceService;

  beforeEach(() => {
    redis = createRedisMock();
    service = new PresenceService(
      presenceRepository as unknown as AgentPresenceRepository,
      orderRepository as unknown as OrderRepository,
      redis as unknown as Redis,
      createShardedKnexMock().knex,
      {} as ConfigService,
    );
  });

  it('goes online in Postgres and Redis', async () => {
    const entity = { agentId: 7, isOnline: true };
    presenceRepository.upsertOnline.mockResolvedValue(entity);

    await expect(service.goOnline('eg', 7, 30, 31)).resolves.toBe(entity);
    expect(redis.pipelineMock.geoadd).toHaveBeenCalledWith(
      expect.any(String),
      31,
      30,
      '7',
    );
    expect(redis.pipelineMock.hmset).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ is_online: '1', active_orders: '0' }),
    );
  });

  it('blocks offline while carrying a picked order', async () => {
    orderRepository.findActiveByAgent.mockResolvedValue([{ status: 'picked' }]);
    await expect(service.goOffline('eg', 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('goes offline and returns an assigned order for reassignment', async () => {
    const createdAt = new Date();
    orderRepository.findActiveByAgent.mockResolvedValue([
      { id: 4, status: 'assigned', createdAt },
    ]);
    presenceRepository.updateOffline.mockResolvedValue({});

    await expect(service.goOffline('eg', 7)).resolves.toEqual({
      ok: true,
      reassignOrderId: 4,
      reassignOrderCreatedAt: createdAt,
      reassignOrderRegion: 'eg',
    });
    expect(redis.pipelineMock.zrem).toHaveBeenCalled();
  });

  it('goes offline without reassignment when no order is active', async () => {
    orderRepository.findActiveByAgent.mockResolvedValue([]);
    await expect(service.goOffline('eg', 7)).resolves.toEqual({ ok: true });
  });

  it('updates pings and rejects agents not online in Postgres', async () => {
    presenceRepository.updatePing.mockResolvedValueOnce(undefined);
    await expect(service.ping('eg', 7, 30, 31)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const entity = { agentId: 7, isOnline: true };
    presenceRepository.updatePing.mockResolvedValue(entity);
    await expect(service.ping('eg', 7, 30, 31)).resolves.toBe(entity);
    expect(redis.pipelineMock.hmset).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ is_online: '1' }),
    );
  });

  it('maps nearby Redis candidates and tolerates malformed replies', async () => {
    redis.call
      .mockResolvedValueOnce([
        ['7', '125.4'],
        ['8', '200'],
      ])
      .mockResolvedValue(undefined);
    await expect(
      service.findNearbyAgentsRedis('eg', 31, 30, 5000, 5),
    ).resolves.toEqual([
      { agentId: 7, distance: 125.4 },
      { agentId: 8, distance: 200 },
    ]);
    await expect(
      service.findNearbyAgentsRedis('eg', 31, 30, 5000, 5),
    ).resolves.toEqual([]);
  });

  it('loads valid agent metadata and skips invalid replies', async () => {
    await expect(service.getAgentsMeta('eg', [])).resolves.toEqual(new Map());
    redis.pipelineMock.exec.mockResolvedValue([
      [
        null,
        { last_seen_at: '1000', active_orders: '1', is_online: '1' },
      ],
      [new Error('redis'), {}],
      [null, {}],
    ]);
    await expect(service.getAgentsMeta('eg', [7, 8, 9])).resolves.toEqual(
      new Map([
        [
          7,
          { lastSeenAt: 1000, activeOrders: 1, isOnline: true },
        ],
      ]),
    );
  });

  it('manages rejection sets', async () => {
    redis.sismember.mockResolvedValueOnce(1).mockResolvedValue(0);
    await expect(service.isRejected(4, 7)).resolves.toBe(true);
    await expect(service.isRejected(4, 8)).resolves.toBe(false);

    await service.addRejection(4, 7);
    expect(redis.sadd).toHaveBeenCalledWith(expect.any(String), '7');
    expect(redis.expire).toHaveBeenCalled();
  });

  it('increments active orders and clears busy state at zero', async () => {
    await service.incrementActiveOrders('eg', 7, 1);
    expect(redis.pipelineMock.sadd).toHaveBeenCalled();

    redis.hget.mockResolvedValue('0');
    await service.incrementActiveOrders('eg', 7, -1);
    expect(redis.srem).toHaveBeenCalledWith(expect.any(String), '7');
  });

  it('evicts stale agents and clears order reject sets', async () => {
    await service.evictStaleAgent('eg', 7);
    expect(redis.pipelineMock.del).toHaveBeenCalled();

    await service.clearRejectSet(4);
    expect(redis.del).toHaveBeenCalled();
  });
});
