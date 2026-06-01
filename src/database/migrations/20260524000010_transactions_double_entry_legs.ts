import type { Knex } from 'knex';

/**
 * Double-entry leg expansion for the `transactions` ledger.
 *
 *  - Extends `transaction_type` CHECK to allow three new leg types written
 *    on order settlement (see AssignmentService.settleDelivered):
 *      * restaurant_credit  — restaurant's share (subtotal)
 *      * agent_earning      — agent's share (delivery_fee − commission)
 *      * service_fee        — platform-collected service fee
 *    Together with the existing `commission` row they sum to the original
 *    `charge` / `cod_collection` amount, giving us a per-order audit trail.
 *
 *  - Adds nullable `reason` column. Today it is only stamped on refund-style
 *    flows; we'll use it later to decide whether a refund should re-credit the
 *    restaurant balance (e.g. reason='restaurant_fault') via a dedicated
 *    endpoint. See CLAUDE.md §7 "Refund legs / restaurant-credit endpoint".
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE transactions
      DROP CONSTRAINT IF EXISTS transactions_transaction_type_check;
  `);
  await knex.raw(`
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_transaction_type_check
      CHECK (transaction_type IN (
        'charge','refund','commission','payout','cod_collection','adjustment',
        'restaurant_credit','agent_earning','service_fee'
      ));
  `);
  await knex.raw(`
    ALTER TABLE transactions
      ADD COLUMN reason TEXT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE transactions
      DROP COLUMN IF EXISTS reason;
  `);
  await knex.raw(`
    ALTER TABLE transactions
      DROP CONSTRAINT IF EXISTS transactions_transaction_type_check;
  `);
  await knex.raw(`
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_transaction_type_check
      CHECK (transaction_type IN (
        'charge','refund','commission','payout','cod_collection','adjustment'
      ));
  `);
}
