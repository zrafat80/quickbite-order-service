import knex, { Knex } from 'knex';
import path from 'path';

const TEST_DATABASE = process.env.DB_eg_NAME ?? 'order_service_test_eg';

function connection(database: string) {
  return {
    host: process.env.DB_eg_HOST ?? 'localhost',
    port: Number(process.env.DB_eg_PORT ?? 5432),
    user: process.env.DB_eg_USERNAME ?? 'postgres',
    password: process.env.DB_eg_PASSWORD ?? '',
    database,
  };
}

export async function ensureOrderTestDatabase(): Promise<void> {
  assertTestDatabaseName(TEST_DATABASE);
  const admin = knex({ client: 'pg', connection: connection('postgres') });
  try {
    const existing = await admin('pg_database')
      .select('datname')
      .where({ datname: TEST_DATABASE })
      .first();
    if (!existing) {
      await admin.raw('CREATE DATABASE ??', [TEST_DATABASE]);
    }
  } finally {
    await admin.destroy();
  }

  const database = knex({
    client: 'pg',
    connection: connection(TEST_DATABASE),
    migrations: {
      directory: path.resolve(process.cwd(), 'src/database/migrations'),
      extension: 'ts',
    },
  });
  try {
    process.env.REGION = 'eg';
    await database.migrate.latest();
  } finally {
    await database.destroy();
  }
}

export function assertOrderTestDatabase(database: Knex): void {
  const configured = String(database.client.config.connection?.database ?? '');
  assertTestDatabaseName(configured);
}

function assertTestDatabaseName(name: string): void {
  if (!name.includes('_test_')) {
    throw new Error(`Refusing integration mutation on non-test database "${name}"`);
  }
}

export async function truncateOrderTables(database: Knex): Promise<void> {
  assertOrderTestDatabase(database);
  await database.raw(`
    TRUNCATE TABLE
      logs,
      idempotency_keys,
      payment_webhook_events,
      agent_earnings,
      agent_presence,
      restaurant_balances,
      events_outbox,
      orders
    RESTART IDENTITY CASCADE
  `);
  await database('payment_providers')
    .insert([
      { id: 1, name: 'kashier', is_enabled: true, priority: 10 },
      { id: 2, name: 'cod', is_enabled: true, priority: 20 },
    ])
    .onConflict('id')
    .merge(['name', 'is_enabled', 'priority']);
}
