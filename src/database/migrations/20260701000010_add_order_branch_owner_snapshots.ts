import type { Knex } from 'knex';

/**
 * Store immutable checkout-time snapshots that are useful for reporting and
 * bulk seeds without joining back to core-service:
 *   - restaurant_owner_id: owner user id from core restaurants.owner_id
 *   - branch_lat/branch_lng: branch coordinates at order placement time
 *
 * Nullable keeps this migration safe for existing rows. New writes populate
 * these columns from core's internal branch metadata.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE orders
      ADD COLUMN restaurant_owner_id BIGINT NULL,
      ADD COLUMN branch_lat DECIMAL(10,7) NULL,
      ADD COLUMN branch_lng DECIMAL(10,7) NULL;
  `);

  await knex.raw(`
    CREATE INDEX idx_orders_restaurant_owner_created_at
      ON orders (restaurant_owner_id, created_at DESC)
      WHERE restaurant_owner_id IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_orders_restaurant_owner_created_at;
  `);
  await knex.raw(`
    ALTER TABLE orders
      DROP COLUMN IF EXISTS branch_lng,
      DROP COLUMN IF EXISTS branch_lat,
      DROP COLUMN IF EXISTS restaurant_owner_id;
  `);
}
