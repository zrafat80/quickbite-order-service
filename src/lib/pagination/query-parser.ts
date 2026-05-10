import { PaginationParams, FilterParams } from './cursor-pagination';

export function parsePaginationQuery(
  query: Record<string, any>,
  columnMap: Record<string, string> = {},
): PaginationParams {
  const rawSortBy = (query.sortBy as string) || 'id';

  return {
    cursor: query.cursor as string,
    limit: Math.min(1000, Number(query.limit) || 10),
    sortBy: columnMap[rawSortBy] || rawSortBy,
    apiSortBy: rawSortBy,
    sortOrder: query.sortOrder === 'desc' ? 'desc' : 'asc',
  };
}

export function parseFilters(
  query: Record<string, any>,
  allowedFields: string[],
  columnMap: Record<string, string> = {},
): FilterParams[] {
  const filter = query.filter;
  if (!filter || typeof filter !== 'object') return [];

  const allowedOps = new Set(['eq', 'gt', 'lt', 'gte', 'lte', 'like', 'in']);

  return allowedFields.flatMap((apiField) => {
    const fieldFilters = filter[apiField];
    if (!fieldFilters || typeof fieldFilters !== 'object') return [];

    const dbField = columnMap[apiField] || apiField;

    return Object.entries(fieldFilters)
      .filter(([op]) => allowedOps.has(op))
      .map(([operator, rawValue]) => {
        let parsedValue: string | string[] = rawValue as string;
        if (operator === 'in' && typeof rawValue === 'string') {
          parsedValue = rawValue.split(',').map((v) => v.trim());
        }
        return {
          field: dbField,
          operator: operator as FilterParams['operator'],
          value: parsedValue,
        };
      });
  });
}
