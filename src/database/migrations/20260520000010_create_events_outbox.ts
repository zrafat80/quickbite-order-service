import type { Knex } from 'knex';

/**
 * Transactional outbox for outbound events. Per-shard table (each region runs
 * its own copy) — no `region` column because each shard's outbox only holds
 * rows produced on that shard.
 *
 * The drainer claims rows with `FOR UPDATE SKIP LOCKED`, publishes them to
 * RabbitMQ with publisher confirms, then marks `dispatched_at`.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE events_outbox (
      id              BIGSERIAL PRIMARY KEY,
      aggregate_type  TEXT NOT NULL,
      aggregate_id    TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      event_id        UUID NOT NULL,
      payload         JSONB NOT NULL,
      attempts        INT NOT NULL DEFAULT 0,
      last_error      TEXT NULL,
      created_at      TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      dispatched_at   TIMESTAMP(3) NULL,
      CONSTRAINT uq_events_outbox_event_id UNIQUE (event_id)
    );
  `);

  // supports the drainer's claimBatch scan (undispatched rows oldest-first)
  await knex.raw(
    `CREATE INDEX idx_events_outbox_undispatched ON events_outbox (id) WHERE dispatched_at IS NULL;`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS events_outbox CASCADE;`);
}
