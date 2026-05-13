import type { Knex } from 'knex';

/**
 * `agent_presence` — one row per delivery agent. Source of truth for
 * online/offline + last known location. The hot read path (assignment scan)
 * lives in Redis (`presence:geo:<region>`), this table is the durable mirror
 * and the fallback when Redis is cold.
 *
 * `location` is a generated `GEOGRAPHY(Point, 4326)` so we can use a partial
 * GIST index for nearest-online lookups (`<->` distance ordering, k-NN).
 *
 * Not partitioned — one row per agent, small bounded cardinality.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS postgis;`);

  await knex.raw(`
    CREATE TABLE agent_presence (
      agent_id      BIGINT PRIMARY KEY,
      region        TEXT NOT NULL,
      is_online     BOOLEAN NOT NULL DEFAULT FALSE,
      last_lat      DECIMAL(10,7) NULL,
      last_lng      DECIMAL(10,7) NULL,
      last_seen_at  TIMESTAMP(3) NOT NULL DEFAULT NOW(),
      location      GEOGRAPHY(Point, 4326) GENERATED ALWAYS AS (
                      CASE
                        WHEN last_lat IS NOT NULL AND last_lng IS NOT NULL
                        THEN ST_SetSRID(ST_MakePoint(last_lng::float, last_lat::float), 4326)::geography
                        ELSE NULL
                      END
                    ) STORED,
      updated_at    TIMESTAMP(3) NOT NULL DEFAULT NOW()
    );
  `);

  // supports auto-assignment proximity scan (Postgres fallback when Redis cold)
  await knex.raw(
    `CREATE INDEX idx_agent_presence_location_gist ON agent_presence USING GIST (location) WHERE is_online = TRUE;`,
  );
  // supports stale-presence cleanup inside the request path
  await knex.raw(
    `CREATE INDEX idx_agent_presence_last_seen_at ON agent_presence (last_seen_at) WHERE is_online = TRUE;`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS agent_presence;`);
  // Leave the extension installed — other tables may rely on it.
}
