import { OrderItemRepository } from 'src/app/order/repository/order-item.repository';
import {
  createShardedKnexMock,
  createTransactionMock,
} from '../helpers/test-doubles';

describe('OrderItemRepository', () => {
  const row = {
    id: '1',
    region: 'eg',
    order_id: '4',
    order_created_at: new Date(),
    product_id: '11',
    quantity: '2',
    unit_price_snapshot: '1200',
    name_snapshot: 'Burger',
    image_url_snapshot: null,
    line_total: '2400',
    created_at: new Date(),
  };

  it('bulk inserts mapped order items and handles empty input', async () => {
    const doubles = createShardedKnexMock();
    const trx = createTransactionMock();
    const repository = new OrderItemRepository(doubles.knex);
    trx.query.returning.mockResolvedValue([row]);

    await expect(repository.bulkInsert([], trx.transaction as never)).resolves.toEqual(
      [],
    );
    await expect(
      repository.bulkInsert(
        [
          {
            region: 'eg',
            orderId: 4,
            orderCreatedAt: row.order_created_at,
            productId: 11,
            quantity: 2,
            unitPriceSnapshot: 1200,
            nameSnapshot: 'Burger',
            imageUrlSnapshot: null,
            lineTotal: 2400,
          },
        ],
        trx.transaction as never,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 1,
        orderId: 4,
        productId: 11,
        lineTotal: 2400,
      }),
    ]);
  });

  it('batch loads mapped items and skips empty keys', async () => {
    const doubles = createShardedKnexMock();
    const repository = new OrderItemRepository(doubles.knex);
    doubles.query.whereIn.mockResolvedValue([row]);

    await expect(repository.findByOrderIds('eg', [])).resolves.toEqual([]);
    await expect(
      repository.findByOrderIds('eg', [
        { orderId: 4, orderCreatedAt: row.order_created_at },
      ]),
    ).resolves.toEqual([expect.objectContaining({ nameSnapshot: 'Burger' })]);
  });
});
