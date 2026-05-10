import type { Knex } from 'knex';

/**
 * `order_items` carries `order_created_at` so the FK can target the
 * partitioned parent's composite (id, created_at) constraint. Every insert
 * sets it from the parent order's `created_at`.
 *
 * Not partitioned: items are always queried by order_id (with a small
 * cardinality per order), so co-locating them with their parent partition
 * adds complexity without buying anything for current-year reads. If item
 * volume becomes a problem we can revisit.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE order_items (
      id                  BIGSERIAL PRIMARY KEY,
      region              TEXT NOT NULL,
      order_id            BIGINT NOT NULL,
      order_created_at    TIMESTAMP(3) NOT NULL,
      product_id          BIGINT NOT NULL,
      quantity            INT NOT NULL CHECK (quantity > 0),
      unit_price_snapshot INT NOT NULL,
      name_snapshot       TEXT NOT NULL,
      image_url_snapshot  TEXT NULL,
      line_total          INT NOT NULL,
      created_at          TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_order_items_order_id
        FOREIGN KEY (order_id, order_created_at)
        REFERENCES orders (id, created_at)
        ON DELETE CASCADE
    );
  `);

  // supports order detail expansion + batch fetch via whereIn(order_id) for lists
  await knex.raw(
    `CREATE INDEX idx_order_items_order_id ON order_items (order_id, order_created_at);`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS order_items;`);
}
