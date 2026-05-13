import type { Knex } from 'knex';

/**
 * Raw webhook log for audit + replay. The unique constraint on
 * (provider_id, provider_event_id) is the dedupe pin: a duplicate POST trips
 * 23505 and short-circuits the handler with 200 OK.
 *
 * `processed_at` / `process_error` are stamped by the handler; if a
 * processing failure happens the row stays unprocessed and Kashier will
 * retry per its policy (every 5 min for 15 min, then every 8h for 24h).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE payment_webhook_events (
      id                  BIGSERIAL PRIMARY KEY,
      region              TEXT NOT NULL,
      provider_id         INT NOT NULL,
      provider_event_id   TEXT NOT NULL,
      event_type          TEXT NOT NULL,
      signature           TEXT NULL,
      payload             JSONB NOT NULL,
      received_at         TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      processed_at        TIMESTAMP(3) NULL,
      process_error       TEXT NULL,
      CONSTRAINT uq_payment_webhook_events_provider_event_id
        UNIQUE (provider_id, provider_event_id)
    );
  `);

  // supports operator queries: "show me unprocessed/failed events"
  await knex.raw(
    `CREATE INDEX idx_payment_webhook_events_unprocessed ON payment_webhook_events (received_at) WHERE processed_at IS NULL;`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS payment_webhook_events;`);
}
