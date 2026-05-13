import type { Knex } from 'knex';

/**
 * `restaurant_balances` — running balance for each restaurant per currency.
 * Phase 3 lands the table; actual balance writes are deferred to Phase 4
 * (restaurant finance). Having the table ready avoids a new migration later.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE restaurant_balances (
      id              BIGSERIAL PRIMARY KEY,
      region          TEXT NOT NULL,
      restaurant_id   BIGINT NOT NULL,
      currency        TEXT NOT NULL,
      balance         BIGINT NOT NULL DEFAULT 0,
      updated_at      TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_restaurant_balances_restaurant_currency
        UNIQUE (restaurant_id, currency)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS restaurant_balances;`);
}
