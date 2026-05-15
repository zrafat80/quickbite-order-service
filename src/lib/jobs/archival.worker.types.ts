import type { Knex } from 'knex';

/**
 * One table in the nightly archival walk.
 *
 * `applyCutoff` builds the "this row belongs to a prior year" predicate. See
 * `archival.worker.ts` for why order-tied child tables filter on
 * `order_created_at` (the parent order's timestamp) rather than their own
 * `created_at`/`earned_at`/`received_at`.
 */
export interface ArchivalTableSpec {
  table: string;
  applyCutoff: (q: Knex.QueryBuilder, cutoff: Date) => Knex.QueryBuilder;
  /** Conflict target for the idempotent archive INSERT — the table's PK columns. */
  conflictTarget: string[];
}

/** Outcome of archiving one table in one region. Aggregated into the run log. */
export interface ArchivalTableResult {
  table: string;
  rowsMoved: number;
  batches: number;
  /** True when the run-time budget was hit mid-table — leftover rows remain. */
  timedOut: boolean;
}
