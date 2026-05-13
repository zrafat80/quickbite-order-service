import type { Knex } from 'knex';

/**
 * `transactions` is the money ledger. Every money movement is one row:
 *   charge | refund | commission | payout | cod_collection | adjustment
 *
 * `order_id` is nullable (payouts are tied to a restaurant, not an order).
 * When set, `order_created_at` is also set so the FK targets the partitioned
 * parent's composite (id, created_at) constraint.
 *
 * `idempotency_key` is unique to deduplicate webhook-driven inserts (we use
 * the upstream `provider_event_id` here).
 *
 * `refunded_payment_id` is a self-FK linking a refund row to its original
 * charge. The FK is not strictly enforced because refunds may be back-dated
 * across partitions; we keep the column un-FK'd for simplicity, mirroring how
 * we handle cross-service references.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE transactions (
      id                      BIGSERIAL PRIMARY KEY,
      region                  TEXT NOT NULL,
      order_id                BIGINT NULL,
      order_created_at        TIMESTAMP(3) NULL,
      transaction_type        TEXT NOT NULL CHECK (transaction_type IN (
                                  'charge','refund','commission','payout',
                                  'cod_collection','adjustment'
                              )),
      method                  TEXT NOT NULL CHECK (method IN (
                                  'online','cod','bank_transfer','system'
                              )),
      provider_id             INT NULL,
      provider_reference_id   TEXT NULL,
      status                  TEXT NOT NULL CHECK (status IN (
                                  'pending','succeeded','failed','reversed'
                              )),
      amount                  INT NOT NULL CHECK (amount >= 0),
      currency                TEXT NOT NULL,
      src_acc_id              BIGINT NULL,
      dst_acc_id              BIGINT NULL,
      is_refunded             BOOLEAN NOT NULL DEFAULT FALSE,
      refunded_payment_id     BIGINT NULL,
      idempotency_key         TEXT NULL,
      created_at              TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_transactions_order_id
        FOREIGN KEY (order_id, order_created_at)
        REFERENCES orders (id, created_at)
        ON DELETE SET NULL,
      CONSTRAINT uq_transactions_idempotency_key
        UNIQUE (idempotency_key),
      CONSTRAINT chk_transactions_order_pair
        CHECK (
          (order_id IS NULL AND order_created_at IS NULL)
          OR (order_id IS NOT NULL AND order_created_at IS NOT NULL)
        )
    );
  `);

  // supports order -> ledger expansion (1 round trip per order)
  await knex.raw(
    `CREATE INDEX idx_transactions_order_id ON transactions (order_id, order_created_at) WHERE order_id IS NOT NULL;`,
  );
  // supports webhook idempotency lookup by provider reference
  await knex.raw(
    `CREATE INDEX idx_transactions_provider_reference_id ON transactions (provider_reference_id) WHERE provider_reference_id IS NOT NULL;`,
  );
  // supports GET /restaurant/payouts?from=&to=
  await knex.raw(
    `CREATE INDEX idx_transactions_dst_acc_type_created_at ON transactions (dst_acc_id, transaction_type, created_at DESC) WHERE transaction_type = 'payout';`,
  );
  // supports admin reconciliation by status + type
  await knex.raw(
    `CREATE INDEX idx_transactions_type_status_created_at ON transactions (transaction_type, status, created_at DESC);`,
  );
  // supports refund chain traversal (charge -> refunds)
  await knex.raw(
    `CREATE INDEX idx_transactions_refunded_payment_id ON transactions (refunded_payment_id) WHERE refunded_payment_id IS NOT NULL;`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS transactions;`);
}
