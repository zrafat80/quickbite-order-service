import type { Knex } from 'knex';

/**
 * DB belt-and-suspenders for the idempotency interceptor. Redis is the hot
 * store; this table is the source of truth on Redis loss/eviction.
 *
 *   key_hash             — sha256(method + path + Idempotency-Key)
 *   request_fingerprint  — sha256(request body); 409 if a replay's body differs
 *   response_status      — original HTTP status to replay
 *   response_body        — original response payload to replay
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE idempotency_keys (
      key_hash            BYTEA PRIMARY KEY,
      region              TEXT NOT NULL,
      user_id             BIGINT NOT NULL,
      request_fingerprint BYTEA NOT NULL,
      response_status     INT NOT NULL,
      response_body       JSONB NOT NULL,
      created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at          TIMESTAMP NOT NULL
    );
  `);

  // supports the cleanup sweep (Phase 7+)
  await knex.raw(
    `CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS idempotency_keys;`);
}
