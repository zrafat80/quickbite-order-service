import { Knex } from 'knex';

export interface PaginationParams {
  cursor?: string;
  limit: number;
  sortBy: string; // mapped (snake_case) for the DB
  apiSortBy: string; // original (camelCase) for the client
  sortOrder: 'asc' | 'desc';
}

export interface FilterParams {
  field: string;
  operator: 'eq' | 'gt' | 'lt' | 'lte' | 'gte' | 'in' | 'like';
  value: string | string[];
}

export interface PaginationMeta {
  nextCursor: string | null;
  hasMore: boolean;
  count: number;
}

// ─── CURSOR ENCODING & DECODING (THE OPAQUE TIE-BREAKER) ───────────────────

export interface DecodedCursor {
  value: Date | string | number;
  id: number;
}

export function encodeCursor(sortValue: Date | string | number, id: number): string {
  // If it's a date, ensure we encode the strict ISO string to maintain precision
  const valStr = sortValue instanceof Date ? sortValue.toISOString() : String(sortValue);
  const raw = `${valStr}|${id}`;
  // Convert to Base64 to make it an opaque cursor for the frontend
  return Buffer.from(raw, 'utf8').toString('base64');
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const parts = raw.split('|');
    if (parts.length !== 2) return null;

    const [valStr, idStr] = parts;
    const id = Number(idStr);
    if (!Number.isFinite(id)) return null;

    // If it looks like an ISO date, parse it back to a JS Date object
    // to prevent node-postgres timezone shifting bugs.
    const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    if (ISO_TIMESTAMP_RE.test(valStr)) {
      const d = new Date(valStr);
      if (!isNaN(d.getTime())) return { value: d, id };
    }

    // Otherwise, treat as number (if possible) or string
    const numVal = Number(valStr);
    return { value: !Number.isNaN(numVal) ? numVal : valStr, id };
  } catch (e) {
    return null; // Return null on bad base64, letting the query fall back to page 1
  }
}

// ─── QUERY BUILDERS ───────────────────────────────────────────────────────

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
export function bindFilterValue(v: string): string | Date {
  if (typeof v === 'string' && ISO_TIMESTAMP_RE.test(v)) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return v;
}

export function applyCursorPagination<T>(
    query: Knex.QueryBuilder,
    params: PaginationParams,
): Knex.QueryBuilder {
  if (!params.sortBy) return query;

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (decoded) {
      const op = params.sortOrder === 'asc' ? '>' : '<';

      // The Golden Rule of Tie-Breakers:
      // WHERE (sort_col < cursor_val) OR (sort_col = cursor_val AND id < cursor_id)
      query.where((builder) => {
        builder
            .where(params.sortBy, op, decoded.value as any)
            .orWhere((subBuilder) => {
              subBuilder
                  .where(params.sortBy, '=', decoded.value as any)
                  .andWhere('id', op, decoded.id);
            });
      });
    }
  }

  // We MUST order by BOTH columns to guarantee the database sorts the collisions exactly
  // how our WHERE clause expects them.
  return query
      .orderBy(params.sortBy, params.sortOrder)
      .orderBy('id', params.sortOrder) // The Secondary Sort (Tie-Breaker)
      .limit(params.limit + 1);
}

export function applyFilters<T>(
    query: Knex.QueryBuilder,
    filters: FilterParams[],
): Knex.QueryBuilder {
  for (const filter of filters) {
    const v = filter.value;
    switch (filter.operator) {
      case 'eq':
        query.where(filter.field, bindFilterValue(v as string));
        break;
      case 'gt':
        query.where(filter.field, '>', bindFilterValue(v as string));
        break;
      case 'lt':
        query.where(filter.field, '<', bindFilterValue(v as string));
        break;
      case 'lte':
        query.where(filter.field, '<=', bindFilterValue(v as string));
        break;
      case 'gte':
        query.where(filter.field, '>=', bindFilterValue(v as string));
        break;
      case 'like':
        query.whereLike(filter.field, `%${v}%`);
        break;
      case 'in':
        query.whereIn(
            filter.field,
            (Array.isArray(v) ? v : [v]).map((x) => bindFilterValue(x)),
        );
        break;
    }
  }
  return query;
}

export function buildPaginationResult<T>(
    rows: T[],
    limit: number,
    sortBy: string,
): { data: T[]; meta: PaginationMeta } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor: string | null = null;

  if (data.length > 0 && hasMore) {
    const lastItem = data[data.length - 1] as any;
    const rawCursorValue = lastItem[sortBy];
    const lastId = lastItem.id; // Grabbing the primary key tie-breaker

    if (rawCursorValue !== undefined && rawCursorValue !== null && lastId !== undefined) {
      nextCursor = encodeCursor(rawCursorValue, lastId);
    }
  }

  return {
    data,
    meta: {
      nextCursor,
      hasMore,
      count: data.length,
    },
  };
}