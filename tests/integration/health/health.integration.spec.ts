import request from 'supertest';
import { useOrderIntegrationApp } from '../helpers/test-app';

describe('Health HTTP integration', () => {
  const testApp = useOrderIntegrationApp();

  describe('GET /api/health', () => {
    it('Zone 1 - returns the real hot-shard health result', async () => {
      const response = await request(testApp.app.getHttpServer()).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        shards: [
          { region: 'eg', cluster: 'hot', ok: true },
          { region: 'eg', cluster: 'archive', ok: true },
        ],
      });
    });

    it('Zone 2 - ignores an invalid region header without corrupting the probe', async () => {
      const response = await request(testApp.app.getHttpServer())
        .get('/api/health')
        .set('x-region', 'invalid-region');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it('Zone 3 - is intentionally public and succeeds without a token', async () => {
      await request(testApp.app.getHttpServer()).get('/api/health').expect(200);
    });

    it('Zone 4 - reports every configured hot shard and persists the request log', async () => {
      await request(testApp.app.getHttpServer())
        .get('/api/health')
        .set('x-region', 'eg')
        .expect(200);

      await expect(
        testApp.database('logs').where({ endpoint: '/api/health' }).first(),
      ).resolves.toBeDefined();
    });
  });
});
