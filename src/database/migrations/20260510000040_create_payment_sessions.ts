import type { Knex } from 'knex';

/**
 * `payment_sessions` mirrors the Kashier "Payment Session" lifecycle so the
 * webhook handler can correlate provider events back to our order.
 *
 * `order_created_at` is carried alongside `order_id` so the FK targets the
 * partitioned parent's composite (id, created_at) constraint — same pattern as
 * `order_items`. Every insert sets it from the parent order's `created_at`.
 *
 * Not partitioned: a session is queried by `order_id` (latest one) or by
 * `provider_session_id` on webhook arrival. Volume tracks orders 1:1 but with
 * fewer rows than `order_items`, so we keep it flat for now.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE payment_sessions (
      id                    BIGSERIAL PRIMARY KEY,
      region                TEXT NOT NULL,
      order_id              BIGINT NOT NULL,
      order_created_at      TIMESTAMP(3) NOT NULL,
      provider_id           INT NOT NULL,
      provider_session_id   TEXT NOT NULL,
      redirect_url          TEXT NOT NULL,
      amount                INT NOT NULL,
      currency              TEXT NOT NULL,
      status                TEXT NOT NULL CHECK (status IN (
                                'initialized','pending','authorized','captured',
                                'failed','expired','cancelled'
                            )),
      raw_init_payload      JSONB NOT NULL,
      raw_last_payload      JSONB NULL,
      expires_at            TIMESTAMP(3) NULL,
      created_at            TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_payment_sessions_order_id
        FOREIGN KEY (order_id, order_created_at)
        REFERENCES orders (id, created_at)
        ON DELETE CASCADE,
      CONSTRAINT uq_payment_sessions_provider_session_id
        UNIQUE (provider_session_id)
    );
  `);

  // supports webhook lookup by Kashier session id
  await knex.raw(
    `CREATE INDEX idx_payment_sessions_provider_session_id ON payment_sessions (provider_session_id);`,
  );
  // supports order -> session lookup (latest)
  await knex.raw(
    `CREATE INDEX idx_payment_sessions_order_id ON payment_sessions (order_id, order_created_at);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS payment_sessions;`);
}
