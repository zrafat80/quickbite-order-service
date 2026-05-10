import type { Knex } from 'knex';

/**
 * Per-region `logs` table. The DatabaseLoggerService writes one row per
 * request to whichever region was resolved by RegionResolverMiddleware
 * (falling back to the first configured region when there's no request
 * context, e.g. system-level logs).
 *
 * Phase 0 exception: the rest of Phase 0 ships no migrations (per
 * implementation-plan §0.4), but the logs table is needed so the global
 * LoggingInterceptor's DB write path doesn't silently no-op.
 */
export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('logs', (table) => {
    table.bigIncrements('id').primary();
    table.string('region').notNullable().index();
    table.timestamp('timestamp').notNullable().defaultTo(knex.fn.now()).index();
    table.string('level').notNullable();
    table.string('correlationId').nullable().index();
    table.string('packetType').notNullable().defaultTo('unknown');
    table.integer('userId').nullable().index();
    table.string('ipAddress').nullable();
    table.string('userAgent').nullable();
    table.string('action').notNullable();
    table.string('endpoint').notNullable();
    table.string('method').notNullable();
    table.integer('responseTime').nullable();
    table.text('errorMessage').nullable();
    table.text('trace').nullable();
    table.text('metadata').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('logs');
}
