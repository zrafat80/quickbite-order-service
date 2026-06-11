import { PaymentProviderRepository } from 'src/app/payment/repository/payment-provider.repository';
import { createShardedKnexMock } from '../helpers/test-doubles';

describe('PaymentProviderRepository', () => {
  it('finds providers by name and id and maps database values', async () => {
    const doubles = createShardedKnexMock();
    const repository = new PaymentProviderRepository(doubles.knex);
    doubles.query.first
      .mockResolvedValueOnce({
        id: '1',
        name: 'kashier',
        is_enabled: 1,
        priority: '10',
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: '2',
        name: 'cod',
        is_enabled: 0,
        priority: '20',
      });

    await expect(repository.findByName('eg', 'kashier')).resolves.toMatchObject({
      id: 1,
      name: 'kashier',
      isEnabled: true,
      priority: 10,
    });
    await expect(repository.findByName('eg', 'missing')).resolves.toBeNull();
    await expect(repository.findById('eg', 2)).resolves.toMatchObject({
      id: 2,
      isEnabled: false,
    });
  });
});
