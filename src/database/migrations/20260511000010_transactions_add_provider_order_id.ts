import type { Knex } from 'knex';

/**
 * Adds `provider_order_id` to `transactions`.
 *
 * Kashier exposes TWO identifiers on the capture webhook:
 *   - transactionId  — the unique payment attempt (we already store it in
 *                      `provider_reference_id`).
 *   - kashierOrderId — the Kashier-side order grouping a transaction belongs
 *                      to. Their refund endpoint is `PUT /orders/{kashierOrderId}/`
 *                      so we need to persist it on the charge to make refunds
 *                      possible. transactionId is NOT accepted on that URL.
 *
 * Stored on `charge` rows. Refund rows inherit it from their parent charge.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE transactions
      ADD COLUMN provider_order_id TEXT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE transactions
      DROP COLUMN provider_order_id;
  `);
}
