import {
  applyFilters,
  bindFilterValue,
  buildPaginationResult,
  decodeCursor,
  encodeCursor,
} from 'src/lib/pagination/cursor-pagination';

describe('cursor pagination', () => {
  it('round-trips date, number, and string cursors', () => {
    const date = new Date('2026-06-07T10:00:00.000Z');
    expect(decodeCursor(encodeCursor(date, 4))).toEqual({
      value: date,
      id: 4,
    });
    expect(decodeCursor(encodeCursor(12, 5))).toEqual({ value: 12, id: 5 });
    expect(decodeCursor(encodeCursor('placed', 6))).toEqual({
      value: 'placed',
      id: 6,
    });
    expect(decodeCursor(Buffer.from('bad').toString('base64'))).toBeNull();
  });

  it('binds ISO timestamps and leaves scalar strings unchanged', () => {
    expect(bindFilterValue('2026-06-07T10:00:00.000Z')).toEqual(
      new Date('2026-06-07T10:00:00.000Z'),
    );
    expect(bindFilterValue('placed')).toBe('placed');
  });

  it('applies all filter operators', () => {
    const query = {
      where: jest.fn().mockReturnThis(),
      whereLike: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
    };
    applyFilters(query as never, [
      { field: 'a', operator: 'eq', value: '1' },
      { field: 'b', operator: 'gt', value: '2' },
      { field: 'c', operator: 'lt', value: '3' },
      { field: 'd', operator: 'lte', value: '4' },
      { field: 'e', operator: 'gte', value: '5' },
      { field: 'f', operator: 'like', value: 'meal' },
      { field: 'g', operator: 'in', value: ['x', 'y'] },
    ]);
    expect(query.where).toHaveBeenCalledTimes(5);
    expect(query.whereLike).toHaveBeenCalledWith('f', '%meal%');
    expect(query.whereIn).toHaveBeenCalledWith('g', ['x', 'y']);
  });

  it('builds opaque next cursors with an id tie-breaker', () => {
    const result = buildPaginationResult(
      [
        { id: 1, createdAt: new Date('2026-06-07T10:00:00.000Z') },
        { id: 2, createdAt: new Date('2026-06-07T11:00:00.000Z') },
      ],
      1,
      'createdAt',
    );
    expect(result.data).toHaveLength(1);
    expect(result.meta).toMatchObject({ hasMore: true, count: 1 });
    expect(decodeCursor(result.meta.nextCursor!)).toEqual({
      value: new Date('2026-06-07T10:00:00.000Z'),
      id: 1,
    });
  });
});
