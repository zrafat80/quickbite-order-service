import type { Knex } from 'knex';

/**
 * `orders` is RANGE-partitioned by month on `created_at`.
 *
 * Why partitioned:
 *   - Hot path queries (`GET /restaurant/orders`, `GET /customer/orders`)
 *     filter by `created_at` window, so partition pruning gives the planner
 *     a tight subset to scan.
 *   - Phase 7's archival worker can detach whole partitions instead of
 *     issuing per-row DELETEs.
 *
 * Partition key in PK / UNIQUE:
 *   PG requires the partition key (`created_at`) to be part of any
 *   PRIMARY KEY or UNIQUE constraint on a partitioned table. So:
 *     - PK = (id, created_at)              — `id` alone stays effectively unique
 *                                            because it comes from BIGSERIAL.
 *     - UNIQUE (public_id, created_at)     — uuid v4 collisions are negligible
 *                                            so `public_id` alone is unique in
 *                                            practice; the composite is the
 *                                            DB-level constraint.
 *
 * Migration creates only the parent + a `default` partition (catches any
 * row outside the rolling window). Real monthly partitions are created by
 * `play/create-partitions.ts` so the active window can roll forward
 * without a migration each month.
 *
 * `default` exists so an INSERT never fails because of a missing partition;
 * during normal operation rows always land in a real monthly partition,
 * but the default acts as a safety net.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE orders (
      id              BIGSERIAL,
      region          TEXT NOT NULL,
      public_id       UUID NOT NULL,
      country_code    TEXT NOT NULL,
      restaurant_id   BIGINT NOT NULL,
      branch_id       BIGINT NOT NULL,
      customer_id     BIGINT NOT NULL,
      customer_address_id BIGINT NOT NULL,
      delivery_lat    DECIMAL(10,7) NOT NULL,
      delivery_lng    DECIMAL(10,7) NOT NULL,
      delivery_address_text_snapshot TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN (
                          'pending_payment','placed','accepted','rejected',
                          'preparing','ready','assigned','picked','delivered','cancelled'
                      )),
      subtotal        INT NOT NULL,
      delivery_fee    INT NOT NULL,
      service_fee     INT NOT NULL,
      total           INT NOT NULL,
      commission      INT NOT NULL DEFAULT 0,
      currency        TEXT NOT NULL,
      payment_method  TEXT NOT NULL CHECK (payment_method IN ('online','cod')),
      -- delivery (no separate `deliveries` table; per-order state lives here)
      delivery_agent_id BIGINT,
      assignment_attempts INT NOT NULL DEFAULT 0,
      last_assignment_at  TIMESTAMP(3) NULL,
      -- TIMESTAMP(3) (millisecond precision) is intentional. node-postgres
      -- returns timestamps as JS Date which only carries ms; with default
      -- microsecond precision the round-trip drops digits and breaks the
      -- composite FK from order_items(order_id, order_created_at).
      created_at      TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      accepted_at     TIMESTAMP(3) NULL,
      rejected_at     TIMESTAMP(3) NULL,
      ready_at        TIMESTAMP(3) NULL,
      assigned_at     TIMESTAMP(3) NULL,
      picked_at       TIMESTAMP(3) NULL,
      delivered_at    TIMESTAMP(3) NULL,
      cancelled_at    TIMESTAMP(3) NULL,
      PRIMARY KEY (id, created_at),
      CONSTRAINT uq_orders_public_id UNIQUE (public_id, created_at)
    ) PARTITION BY RANGE (created_at);
  `);

  // supports GET /orders/{publicId}            -- single-shard, single-row lookup
  await knex.raw(`CREATE INDEX idx_orders_public_id ON orders (public_id);`);
  // supports GET /customer/orders?year=YYYY     -- customer history, current year hot
  await knex.raw(
    `CREATE INDEX idx_orders_customer_id_created_at ON orders (customer_id, created_at DESC);`,
  );
  // supports GET /restaurant/orders?branchId=&status=&from=&to=
  await knex.raw(
    `CREATE INDEX idx_orders_branch_status_created_at ON orders (branch_id, status, created_at DESC);`,
  );
  // supports auto-assignment scan for ready/assigned orders in a region
  await knex.raw(
    `CREATE INDEX idx_orders_status_created_at ON orders (status, created_at) WHERE status IN ('ready','assigned');`,
  );
  // supports GET /agents/tasks?status=
  await knex.raw(
    `CREATE INDEX idx_orders_delivery_agent_id_status ON orders (delivery_agent_id, status) WHERE delivery_agent_id IS NOT NULL;`,
  );

  // Default catch-all partition for any row outside a real monthly window.
  await knex.raw(`CREATE TABLE orders_default PARTITION OF orders DEFAULT;`);
}

export async function down(knex: Knex): Promise<void> {
  // DROP TABLE on the parent cascades to all attached partitions.
  await knex.raw(`DROP TABLE IF EXISTS orders CASCADE;`);
}
