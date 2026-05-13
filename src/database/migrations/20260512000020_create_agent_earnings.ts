import type { Knex } from 'knex';

/**
 * `agent_earnings` — one row per delivered order. Inserted in the same trx
 * as the `orders.status='delivered'` flip. UNIQUE on `order_id` makes a
 * duplicate `deliver` call idempotent.
 *
 * Composite FK targets the partitioned `orders(id, created_at)` parent —
 * same shape as `order_items.fk_order_items_order_id`.
 *
 * Not partitioned — earning rows are read by `(agent_id, earned_at)`
 * windows; co-locating with order partitions adds complexity without buying
 * anything for the agent dashboard.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE agent_earnings (
      id                BIGSERIAL PRIMARY KEY,
      region            TEXT NOT NULL,
      agent_id          BIGINT NOT NULL,
      order_id          BIGINT NOT NULL,
      order_created_at  TIMESTAMP(3) NOT NULL,
      amount            INT NOT NULL CHECK (amount >= 0),
      currency          TEXT NOT NULL,
      earned_at         TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_agent_earnings_order_id
        FOREIGN KEY (order_id, order_created_at)
        REFERENCES orders (id, created_at)
        ON DELETE CASCADE,
      CONSTRAINT uq_agent_earnings_order_id UNIQUE (order_id)
    );
  `);

  // supports GET /agents/earnings?from=&to=
  await knex.raw(
    `CREATE INDEX idx_agent_earnings_agent_earned_at ON agent_earnings (agent_id, earned_at DESC);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS agent_earnings;`);
}
