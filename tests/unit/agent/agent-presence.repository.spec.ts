import { AgentPresenceRepository } from 'src/app/agent/repository/agent-presence.repository';
import { createShardedKnexMock } from '../helpers/test-doubles';

describe('AgentPresenceRepository', () => {
  const row = {
    agent_id: '7',
    region: 'eg',
    is_online: true,
    last_lat: '30.1',
    last_lng: '31.2',
    last_seen_at: new Date(),
    updated_at: new Date(),
  };

  it('upserts, updates, and claims presence rows', async () => {
    const doubles = createShardedKnexMock();
    const repository = new AgentPresenceRepository(doubles.knex);
    doubles.database.raw
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });
    doubles.transaction.raw.mockResolvedValue({ rows: [row] });

    await expect(
      repository.upsertOnline('eg', {
        agentId: 7,
        region: 'eg',
        lat: 30.1,
        lng: 31.2,
      }),
    ).resolves.toMatchObject({ agentId: 7, isOnline: true });
    await expect(repository.updateOffline('eg', 7)).resolves.toMatchObject({
      agentId: 7,
    });
    await expect(repository.updatePing('eg', 8, 30, 31)).resolves.toBeNull();
    await expect(
      repository.claimForUpdate('eg', 7, doubles.transaction as never),
    ).resolves.toMatchObject({ agentId: 7 });
  });

  it('finds individual and nearby agents', async () => {
    const doubles = createShardedKnexMock();
    const repository = new AgentPresenceRepository(doubles.knex);
    doubles.query.first
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(undefined);
    await expect(repository.findByAgentId('eg', 7)).resolves.toMatchObject({
      lastLat: 30.1,
      lastLng: 31.2,
    });
    await expect(repository.findByAgentId('eg', 8)).resolves.toBeNull();

    doubles.database.raw.mockResolvedValue({
      rows: [{ agent_id: '7', distance_meters: '125.4' }],
    });
    await expect(
      repository.findOnlineNearestPostgres('eg', 30, 31, 5, 300),
    ).resolves.toEqual([{ agentId: 7, distanceMeters: 125.4 }]);
  });
});
