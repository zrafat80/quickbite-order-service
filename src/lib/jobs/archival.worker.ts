import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import Redis from 'ioredis';
import { ShardedKnex } from '../sharding/shards';
import { REDIS_CLIENT } from '../cache/redis.module';
import { ArchivalTableResult, ArchivalTableSpec } from './archival.worker.types';

/** Rows moved per batch. implementation-plan §6.2 fixes this at 1000. */
const BATCH_SIZE = 1000;

/**
 * Per-region lock TTL = `ARCHIVAL_MAX_RUNTIME_MIN` + this buffer. Kept above
 * the worst-case run so the lock never expires mid-run (which would let a
 * second process in); a crashed process still frees the lock after the TTL.
 */
const LOCK_TTL_BUFFER_MIN = 15;

/**
 * Compare-and-delete: release the lock only if we still own it, so a slow run
 * can't delete a lock another process acquired after ours expired.
 */
const RELEASE_LOCK_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

/**
 * Nightly cold-storage archival worker (implementation-plan Phase 6.2).
 *
 * Every night it moves rows whose owning order is in a **prior year** from the
 * hot cluster to the archive cluster, per region, so current-year queries on
 * the hot DB stay fast.
 *
 * ── FK direction conflict (deviation from the plan's single-pass sketch) ──
 * `orders` is the sole parent; every other table is a leaf with an FK to
 * `orders(id, created_at)`. That FK pulls in two opposite directions:
 *   - archive INSERT must be parent-first — a child row can't be inserted
 *     before its parent order exists in the archive cluster;
 *   - hot DELETE must be child-first — deleting an order CASCADE-deletes its
 *     children (and SET NULLs `transactions`), so deleting a parent before its
 *     children are copied would destroy un-archived rows.
 * A naive "for each table: copy then delete" pass cannot satisfy both. The run
 * is therefore three segments:
 *   A. copy `orders` → archive            (INSERT only, keyset-paginated)
 *   B. for each child: copy → archive, then delete from hot
 *   C. delete `orders` from hot           (children already gone → CASCADE no-op)
 *
 * ── Cutoff column ──
 * `orders` is filtered on its own `created_at`. Order-tied children are
 * filtered on `order_created_at` (the parent's timestamp) so a child is
 * archived *exactly* when its parent is — never stranded, never orphaned.
 * `transactions` payout rows have no order, so those fall back to their own
 * `created_at`. `payment_webhook_events` has no order FK and no `created_at`,
 * so it uses `received_at`.
 *
 * ── Crash safety ──
 * Within a batch the archive INSERT commits before the hot DELETE, so a crash
 * in between leaves rows in BOTH clusters (safer than NEITHER). Every archive
 * INSERT is `ON CONFLICT DO NOTHING`, so a re-run heals duplicates. Each
 * segment is independently resumable; the run is idempotent end-to-end.
 */
@Injectable()
export class ArchivalWorker {
  private readonly logger = new Logger(ArchivalWorker.name);

  constructor(
    @Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {}

  /** Parent table — copied in segment A, deleted in segment C. */
  private readonly ordersSpec: ArchivalTableSpec = {
    table: 'orders',
    applyCutoff: (q, cutoff) => q.where('created_at', '<', cutoff),
    conflictTarget: ['id', 'created_at'],
  };

  /**
   * Child tables — copied + deleted in segment B. Order within the segment is
   * irrelevant: every entry is a leaf whose only FK points at `orders`.
   */
  private readonly childSpecs: ArchivalTableSpec[] = [
    {
      table: 'agent_earnings',
      applyCutoff: (q, cutoff) => q.where('order_created_at', '<', cutoff),
      conflictTarget: ['id'],
    },
    {
      table: 'payment_webhook_events',
      applyCutoff: (q, cutoff) => q.where('received_at', '<', cutoff),
      conflictTarget: ['id'],
    },
    {
      table: 'payment_sessions',
      applyCutoff: (q, cutoff) => q.where('order_created_at', '<', cutoff),
      conflictTarget: ['id'],
    },
    {
      table: 'transactions',
      // Order-tied rows track their parent; payout rows (order_id IS NULL)
      // have no order, so they fall back to their own created_at.
      applyCutoff: (q, cutoff) =>
        q.where((b) =>
          b
            .where('order_created_at', '<', cutoff)
            .orWhere((p) =>
              p.whereNull('order_id').andWhere('created_at', '<', cutoff),
            ),
        ),
      conflictTarget: ['id'],
    },
    {
      table: 'order_items',
      applyCutoff: (q, cutoff) => q.where('order_created_at', '<', cutoff),
      conflictTarget: ['id'],
    },
  ];

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async archiveOldData(): Promise<void> {
    // Cutoff = start of the current UTC year. Computed once in JS so the hot
    // and archive queries agree regardless of either DB server's timezone.
    const cutoff = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
    this.logger.log(
      `Nightly archival starting — prior-year cutoff ${cutoff.toISOString()}.`,
    );
    for (const region of this.knex.regions()) {
      await this.archiveRegion(region, cutoff);
    }
    this.logger.log('Nightly archival finished.');
  }

  private async archiveRegion(region: string, cutoff: Date): Promise<void> {
    // Regions without an archive cluster (typical in dev) are skipped — the
    // sharded resolver throws when an unconfigured archive shard is requested.
    let archiveDb: Knex;
    try {
      archiveDb = this.knex.dbArchive(region);
    } catch {
      this.logger.warn(
        `Region ${region}: no archive cluster configured — skipping.`,
      );
      return;
    }
    const hotDb = this.knex.db(region);

    const maxRuntimeMin =
      this.configService.get<number>('archival.maxRuntimeMin') ?? 60;
    const deadline = Date.now() + maxRuntimeMin * 60_000;

    const lockKey = `archival:${region}:lock`;
    const lockToken = randomUUID();
    if (!(await this.acquireLock(lockKey, lockToken, maxRuntimeMin))) {
      this.logger.warn(
        `Region ${region}: archival lock held by another process — skipping.`,
      );
      return;
    }

    const startedAt = Date.now();
    try {
      // ── Segment A: copy orders into the archive (no deletes yet) ──
      const ordersCopied = await this.copyOrders(
        region,
        cutoff,
        hotDb,
        archiveDb,
        deadline,
      );
      this.logBatchResult(region, 'copy', ordersCopied);
      if (ordersCopied.timedOut) {
        // Segment B inserts children that FK-reference these orders; it is
        // unsafe until every prior-year order is in the archive.
        this.logger.warn(
          `Region ${region}: stopped after partial orders copy — resuming next run.`,
        );
        return;
      }

      // ── Segment B: copy + delete each child table ──
      for (const spec of this.childSpecs) {
        if (Date.now() >= deadline) {
          this.logger.warn(
            `Region ${region}: max runtime reached before ${spec.table} — resuming next run.`,
          );
          return;
        }
        const childResult = await this.copyChildTable(
          region,
          spec,
          cutoff,
          hotDb,
          archiveDb,
          deadline,
        );
        this.logBatchResult(region, 'move', childResult);
        if (childResult.timedOut) return;
      }

      // ── Segment C: delete the now-childless orders from the hot cluster ──
      const ordersDeleted = await this.deleteOrders(
        region,
        cutoff,
        hotDb,
        archiveDb,
        deadline,
      );
      this.logBatchResult(region, 'delete', ordersDeleted);
    } catch (err) {
      this.logger.error(
        `Region ${region}: archival aborted — ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      await this.releaseLock(lockKey, lockToken);
      this.logger.log(
        `Region ${region}: archival run took ${Date.now() - startedAt}ms.`,
      );
    }
  }

  /**
   * Segment A — copy every prior-year `orders` row into the archive cluster.
   * No deletes happen here, so the batch loop keyset-paginates on `id`
   * (a plain `WHERE cutoff LIMIT n` would re-select the same rows forever).
   */
  private async copyOrders(
    region: string,
    cutoff: Date,
    hotDb: Knex,
    archiveDb: Knex,
    deadline: number,
  ): Promise<ArchivalTableResult> {
    let rowsMoved = 0;
    let batches = 0;
    let afterId: string | null = null;

    for (;;) {
      if (Date.now() >= deadline) {
        return { table: 'orders', rowsMoved, batches, timedOut: true };
      }
      const batchStart = Date.now();

      let query = hotDb('orders')
        // SELECT * is deliberate: an archival copy must be column-faithful, and
        // a hard-coded list would silently drop any column a later migration
        // adds. Justified deviation from CLAUDE.md §9.3.
        .select('*')
        .where('created_at', '<', cutoff)
        .orderBy('id', 'asc')
        .limit(BATCH_SIZE);
      if (afterId !== null) query = query.where('id', '>', afterId);
      const rows = await query;
      if (rows.length === 0) break;

      await archiveDb('orders')
        .insert(rows)
        .onConflict(['id', 'created_at'])
        .ignore();
      await this.assertCopied(
        archiveDb,
        'orders',
        rows.map((r: any) => r.id),
      );

      afterId = String(rows[rows.length - 1].id);
      rowsMoved += rows.length;
      batches += 1;
      this.logger.debug(
        `Region ${region}: orders copy batch ${batches} — ${rows.length} rows in ${Date.now() - batchStart}ms.`,
      );
      if (rows.length < BATCH_SIZE) break;
    }
    return { table: 'orders', rowsMoved, batches, timedOut: false };
  }

  /**
   * Segment B — copy one child table to the archive then delete the moved
   * batch from hot. Because each batch is deleted, the next plain
   * `WHERE cutoff LIMIT n` select naturally surfaces the following batch.
   */
  private async copyChildTable(
    region: string,
    spec: ArchivalTableSpec,
    cutoff: Date,
    hotDb: Knex,
    archiveDb: Knex,
    deadline: number,
  ): Promise<ArchivalTableResult> {
    let rowsMoved = 0;
    let batches = 0;

    for (;;) {
      if (Date.now() >= deadline) {
        return { table: spec.table, rowsMoved, batches, timedOut: true };
      }
      const batchStart = Date.now();

      const rows = await spec
        .applyCutoff(hotDb(spec.table).select('*'), cutoff)
        .orderBy('id', 'asc')
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;

      const ids = rows.map((r: any) => r.id);

      // 1. Copy into the archive. ON CONFLICT DO NOTHING makes a re-run after
      //    a mid-batch crash a no-op for rows already copied.
      await archiveDb(spec.table)
        .insert(rows)
        .onConflict(spec.conflictTarget)
        .ignore();

      // 2. Validate the copy landed before touching the hot cluster
      //    (system-design §10: "validates the copy, then deletes from hot").
      await this.assertCopied(archiveDb, spec.table, ids);

      // 3. Delete the verified batch from hot. The archive INSERT above is
      //    already committed, so a crash here leaves rows in both clusters.
      await hotDb(spec.table).whereIn('id', ids).delete();

      rowsMoved += rows.length;
      batches += 1;
      this.logger.debug(
        `Region ${region}: ${spec.table} move batch ${batches} — ${rows.length} rows in ${Date.now() - batchStart}ms.`,
      );
      if (rows.length < BATCH_SIZE) break;
    }
    return { table: spec.table, rowsMoved, batches, timedOut: false };
  }

  /**
   * Segment C — delete prior-year `orders` from the hot cluster. Their child
   * rows were already moved in segment B, so the ON DELETE CASCADE / SET NULL
   * FKs have nothing left to act on. Each batch is re-validated against the
   * archive so an order is never deleted unless its copy is confirmed present.
   */
  private async deleteOrders(
    region: string,
    cutoff: Date,
    hotDb: Knex,
    archiveDb: Knex,
    deadline: number,
  ): Promise<ArchivalTableResult> {
    let rowsMoved = 0;
    let batches = 0;

    for (;;) {
      if (Date.now() >= deadline) {
        return { table: 'orders', rowsMoved, batches, timedOut: true };
      }
      const batchStart = Date.now();

      const rows = await hotDb('orders')
        .select('id')
        .where('created_at', '<', cutoff)
        .orderBy('id', 'asc')
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;

      const ids = rows.map((r: any) => r.id);
      await this.assertCopied(archiveDb, 'orders', ids);

      // `created_at < cutoff` lets the planner prune to prior-year partitions
      // instead of scanning every monthly partition for the id list.
      await hotDb('orders')
        .where('created_at', '<', cutoff)
        .whereIn('id', ids)
        .delete();

      rowsMoved += rows.length;
      batches += 1;
      this.logger.debug(
        `Region ${region}: orders delete batch ${batches} — ${rows.length} rows in ${Date.now() - batchStart}ms.`,
      );
      if (rows.length < BATCH_SIZE) break;
    }
    return { table: 'orders', rowsMoved, batches, timedOut: false };
  }

  /**
   * Fail loudly if the archive cluster does not hold every id of a batch we
   * are about to (or just did) move — guards against deleting un-archived data.
   */
  private async assertCopied(
    archiveDb: Knex,
    table: string,
    ids: unknown[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const [{ count }] = await archiveDb(table)
      .whereIn('id', ids as (string | number)[])
      .count<{ count: string }[]>('* as count');
    if (Number(count) !== ids.length) {
      throw new Error(
        `${table}: archive copy validation failed — expected ${ids.length} rows, found ${count}.`,
      );
    }
  }

  private logBatchResult(
    region: string,
    verb: string,
    result: ArchivalTableResult,
  ): void {
    this.logger.log(
      `Region ${region}: ${verb} ${result.table} — rows=${result.rowsMoved} ` +
        `batches=${result.batches}${result.timedOut ? ' (timed out)' : ''}.`,
    );
  }

  private async acquireLock(
    key: string,
    token: string,
    maxRuntimeMin: number,
  ): Promise<boolean> {
    const ttlSec = (maxRuntimeMin + LOCK_TTL_BUFFER_MIN) * 60;
    const res = await this.redis.set(key, token, 'EX', ttlSec, 'NX');
    return res === 'OK';
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, key, token);
    } catch (err) {
      this.logger.error(
        `Failed to release archival lock ${key}: ${(err as Error).message}`,
      );
    }
  }
}
