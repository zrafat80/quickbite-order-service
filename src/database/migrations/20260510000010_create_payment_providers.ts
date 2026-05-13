import type { Knex } from 'knex';

/**
 * `payment_providers` is the small lookup of payment backends. Replicated to
 * every region's DB but treated as effectively read-only seed data.
 *
 * Seeding rules per CLAUDE.md / user instruction:
 *   - `cod` is seeded on EVERY shard.
 *   - `kashier` is seeded ONLY on the `eg` shard today (KSA does not yet have
 *     a Kashier merchant). The check uses the `REGION` env var that drives
 *     `knexfile.ts`.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE payment_providers (
      id          INT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
      priority    SMALLINT NOT NULL DEFAULT 100
    );
  `);

  // cod is universal.
  await knex('payment_providers')
    .insert({ id: 2, name: 'cod', is_enabled: true, priority: 20 })
    .onConflict('id')
    .ignore();

  // kashier only on eg today.
  const region = process.env.REGION;
  if (region === 'eg') {
    await knex('payment_providers')
      .insert({ id: 1, name: 'kashier', is_enabled: true, priority: 10 })
      .onConflict('id')
      .ignore();
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS payment_providers;`);
}
