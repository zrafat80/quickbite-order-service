# play/ — local verification scripts

Untracked (see `.gitignore`). Each script is self-contained and runnable with
`npx tsx play/<name>.ts`. They import directly from `src/` so they always
exercise the real code.

| Script                     | What it verifies                                                 | Infra needed          |
| -------------------------- | ---------------------------------------------------------------- | --------------------- |
| `test-sharding.ts`         | Shard router returns distinct Knex instances per region; pings all shards | Postgres (4 dbs)    |
| `test-region-resolver.ts`  | `resolveRegion` middleware precedence: query > jwt > header > none | none (unit-style)   |
| `test-money.ts`            | Minor-unit helpers (toMinor / fromMinor / sumMinor)              | none                  |
| `test-core-client.ts`      | Core client sends API-key header, retries on 5xx, forwards X-CorrelationId | tiny mock server (spun up in-script) |
| `test-ws.ts`               | End-to-end: WS auth, subscribe, publish-via-Redis fans out to the right socket | Running dev server (npm run dev) + Redis |
| `test-rabbit.ts`           | Publish a test event to `core.events`; consumer inserts into `core_inbound_events` and acks | Running dev server + RabbitMQ + Postgres |

Run `npm run dev` in one terminal before running the WS / RabbitMQ scripts.
