import {
  parseFilters,
  parsePaginationQuery,
} from 'src/lib/pagination/query-parser';

describe('query parser', () => {
  it('maps bounded pagination options', () => {
    expect(
      parsePaginationQuery(
        { cursor: 'abc', limit: '5000', sortBy: 'createdAt', sortOrder: 'desc' },
        { createdAt: 'created_at' },
      ),
    ).toEqual({
      cursor: 'abc',
      limit: 1000,
      sortBy: 'created_at',
      apiSortBy: 'createdAt',
      sortOrder: 'desc',
    });
  });

  it('keeps only allowed filter operations', () => {
    expect(
      parseFilters(
        {
          filter: {
            status: { eq: 'placed', in: 'placed,ready', bad: 'ignored' },
          },
        },
        ['status'],
        { status: 'order_status' },
      ),
    ).toEqual([
      { field: 'order_status', operator: 'eq', value: 'placed' },
      {
        field: 'order_status',
        operator: 'in',
        value: ['placed', 'ready'],
      },
    ]);
    expect(parseFilters({}, ['status'])).toEqual([]);
  });
});
