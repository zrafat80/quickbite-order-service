# Folder Structure — `order-service`

Mirrors `core-service` (NestJS 10 on `@nestjs/platform-express`) exactly. Order-service-specific additions are flagged inline.

---

## Tree (target end state)

```
order-service/
├── .env
├── .gitignore
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── nest-cli.json
├── CLAUDE.md
├── docs/
│   ├── api-contracts.md
│   ├── business-logic/
│   │   ├── orders.md
│   │   ├── payments.md
│   │   ├── deliveries.md
│   │   ├── agents.md
│   │   ├── restaurant-finance.md
│   │   └── rbac.md
│   ├── database-design.md
│   ├── folder-structure.md
│   ├── implementation-plan.md
│   └── system-design.md
└── src/
    ├── main.ts                       # bootstrap: helmet, cors, /api prefix, swagger, cookie-parser, global ValidationPipe + filters + SuccessInterceptor, enableShutdownHooks
    ├── app.module.ts                 # root @Module: imports CacheModule + ScheduleModule + ConfigModule + DatabaseModule + every feature module; registers global APP_FILTER, APP_INTERCEPTOR, RequestContextService; applies CorrelationMiddleware to all routes
    │
    ├── app/                          # business modules
    │   ├── health/
    │   │   ├── health.module.ts
    │   │   └── health.controller.ts
    │   │
    │   ├── order/
    │   │   ├── order.module.ts
    │   │   ├── order.controller.ts
    │   │   ├── order.service.ts
    │   │   ├── order-status.service.ts            # status machine helpers
    │   │   ├── repository/order.repository.ts
    │   │   ├── repository/order-item.repository.ts
    │   │   ├── entity/order.entity.ts
    │   │   ├── entity/order-item.entity.ts
    │   │   ├── dto/create-order.dto.ts            # request
    │   │   ├── dto/order.response.dto.ts          # response (order-service deviation)
    │   │   ├── dto/order-item.response.dto.ts
    │   │   ├── enums.ts
    │   │   └── order.constants.ts                 # ORDER_ERRORS dict + ORDER_COLUMNS
    │   │
    │   ├── payment/
    │   │   ├── payment.module.ts
    │   │   ├── payment.controller.ts
    │   │   ├── payment-webhook.controller.ts      # /payments/webhook/:provider — no auth guard
    │   │   ├── payment.service.ts
    │   │   ├── kashier-webhook.service.ts
    │   │   ├── repository/payment-session.repository.ts
    │   │   ├── repository/transaction.repository.ts
    │   │   ├── repository/payment-webhook-event.repository.ts
    │   │   ├── repository/payment-provider.repository.ts
    │   │   ├── entity/payment-session.entity.ts
    │   │   ├── entity/transaction.entity.ts
    │   │   ├── dto/init-payment.dto.ts            # request
    │   │   ├── dto/payment.response.dto.ts        # response
    │   │   ├── dto/transaction.response.dto.ts
    │   │   ├── enums.ts
    │   │   └── payment.constants.ts
    │   │
    │   ├── delivery/
    │   │   ├── delivery.module.ts
    │   │   ├── delivery.controller.ts
    │   │   ├── delivery.service.ts
    │   │   ├── assignment.service.ts              # auto + manual + reassign logic
    │   │   ├── repository/delivery.repository.ts
    │   │   ├── entity/delivery.entity.ts
    │   │   ├── dto/assign-delivery.dto.ts         # request
    │   │   ├── dto/delivery.response.dto.ts       # response
    │   │   ├── enums.ts
    │   │   └── delivery.constants.ts
    │   │
    │   ├── agent/
    │   │   ├── agent.module.ts
    │   │   ├── agent.controller.ts
    │   │   ├── presence.controller.ts
    │   │   ├── agent.service.ts
    │   │   ├── presence.service.ts
    │   │   ├── earning.service.ts
    │   │   ├── repository/agent-presence.repository.ts
    │   │   ├── repository/agent-earning.repository.ts
    │   │   ├── entity/agent-presence.entity.ts
    │   │   ├── entity/agent-earning.entity.ts
    │   │   ├── dto/update-presence.dto.ts         # request
    │   │   ├── dto/agent.response.dto.ts          # response
    │   │   ├── enums.ts
    │   │   └── agent.constants.ts
    │   │
    │   └── restaurant-finance/
    │       ├── restaurant-finance.module.ts
    │       ├── restaurant-finance.controller.ts
    │       ├── restaurant-finance.service.ts
    │       ├── repository/restaurant-balance.repository.ts
    │       ├── entity/restaurant-balance.entity.ts
    │       ├── dto/restaurant-balance.response.dto.ts
    │       └── restaurant-finance.constants.ts
    │
    ├── lib/                          # cross-cutting infrastructure (NestJS-aware)
    │   ├── cache/
    │   │   ├── cache.interceptor.ts             # UnifiedCacheInterceptor — Redis-backed, scope-aware, stampede-safe (port of core)
    │   │   └── cache-scope.decorator.ts         # @CacheScope('PUBLIC' | 'PRIVATE')
    │   ├── config/
    │   │   └── app.config.ts                    # @nestjs/config factory; reads process.env, returns typed config tree (region list, Kashier, AMQP, JWT secrets, …)
    │   ├── context/
    │   │   └── request-context.service.ts       # AsyncLocalStorage holding correlationId + region for the request
    │   ├── database.module.ts                   # @Global() — exports KNEX_CONNECTION + DatabaseService
    │   ├── database.providers.ts                # KNEX_CONNECTION factory (sharded — see CLAUDE.md §8)
    │   ├── database.service.ts                  # OnApplicationShutdown — destroys every per-region pool
    │   ├── decorators/
    │   │   └── permissions.decorator.ts         # @RequirePermissions(resource, action, allowSystemAdmin?)
    │   ├── filters/
    │   │   ├── http-exception.filter.ts         # global error envelope w/ correlationId + timestamp
    │   │   └── database-error.filter.ts         # maps PG SQLSTATE codes (23505, 23503, 23502, 42703, 22001) to HTTP status
    │   ├── idempotency/
    │   │   ├── idempotency.interceptor.ts       # Redis (+ DB fallback) idempotency on annotated routes
    │   │   └── idempotency.decorator.ts         # @Idempotency({ strict: true })
    │   ├── interceptors/
    │   │   └── success.interceptor.ts           # global response envelope `{ statusCode, isSuccess, message, data, [meta] }`; auto-hoists pagination meta
    │   ├── logging/
    │   │   ├── database-logger.service.ts       # writes to a `logs` table (mirrors core)
    │   │   ├── log.interface.ts
    │   │   └── logging.interceptor.ts           # captures request/response metadata into the logger
    │   ├── middleware/
    │   │   ├── correlation.middleware.ts        # x-correlation-id → AsyncLocalStorage (applied to all routes in app.module)
    │   │   └── guards/
    │   │       ├── jwtGuard.ts                  # reads cookies.access_token, populates req.user
    │   │       ├── permissions.guard.ts         # consumes @RequirePermissions metadata via Reflector
    │   │       ├── restaurant-member.guard.ts   # req.user.restaurantId vs route param
    │   │       ├── branch-access.guard.ts       # req.user.branchIds vs route param
    │   │       ├── internal-api-key.guard.ts    # NEW vs core — for /internal/* routes
    │   │       └── guard.constants.ts
    │   ├── pagination/
    │   │   ├── query-parser.ts                  # parsePaginationQuery + parseFilters (cursor-based)
    │   │   └── cursor-pagination.ts             # cursor encode/decode + meta builder
    │   ├── types/
    │   │   └── express.d.ts                     # extends Request: user, correlationId, region
    │   │
    │   # ─── NEW vs core (order-service-specific) ───
    │   ├── core-client/                         # sync HTTP client to core-service
    │   │   ├── core-client.module.ts            # @Module — exports the clients
    │   │   ├── core.http-client.ts              # base wrapper: retry, correlation forwarding, errors
    │   │   ├── branch.client.ts
    │   │   ├── product.client.ts
    │   │   ├── permission.client.ts
    │   │   └── address.client.ts
    │   ├── core-events/                         # inbound async from core-service (RabbitMQ)
    │   │   ├── core-events.module.ts            # @Module — wires consumer + handlers
    │   │   ├── core-events.consumer.ts          # OnModuleInit / OnApplicationShutdown — declare queue, bind patterns, prefetch, manual-ack loop
    │   │   # dedupe lives in Redis (SETNX on `core-events:dedupe:<eventId>`); no SQL table
    │   │   └── handlers/                        # one file per event type, registered in a dispatch map
    │   │       ├── product-stock-changed.handler.ts
    │   │       ├── product-price-changed.handler.ts
    │   │       ├── branch-deactivated.handler.ts
    │   │       ├── branch-updated.handler.ts
    │   │       ├── restaurant-suspended.handler.ts
    │   │       └── rbac-permissions-changed.handler.ts
    │   ├── messaging/                           # AMQP connection + topology lifecycle
    │   │   ├── messaging.module.ts              # @Global() — connection injectable everywhere
    │   │   ├── amqp.connection.ts               # OnModuleInit / OnApplicationShutdown — single connection; channel-per-consumer
    │   │   └── topology.ts                      # exchange/queue/DLQ declarations (idempotent)
    │   ├── sharding/                            # region resolver
    │   │   ├── sharding.module.ts
    │   │   ├── region-resolver.middleware.ts    # request → region (X-Region header / cookie / query); writes to req + AsyncLocalStorage
    │   │   └── regions.ts                       # canonical list + helpers
    │   ├── jobs/                                # background workers (Phase 7 only)
    │   │   ├── jobs.module.ts
    │   │   └── archival.worker.ts               # @Cron via @nestjs/schedule — moves rows older than current year to the archive cluster
    │   └── websocket/                           # socket.io gateway scaffold (Phase 0)
    │       ├── ws.module.ts
    │       ├── ws.gateway.ts                    # @WebSocketGateway, JWT handshake, channel rooms
    │       ├── ws.publisher.ts                  # services call this after a commit
    │       └── ws-auth.ts                       # JWT verify + permitted-channel derivation
    │
    ├── pkg/                          # framework-agnostic, app-agnostic — NO NestJS decorators here
    │   ├── cache/
    │   │   ├── cache.interface.ts
    │   │   └── redis.ts
    │   ├── messaging/                            # NEW vs core
    │   │   ├── message-broker.interface.ts      # IMessageBroker: connect, consume, publish
    │   │   └── rabbitmq/
    │   │       ├── rabbitmq.client.ts            # amqplib wrapper — no Nest, no env, no app types
    │   │       └── rabbitmq.types.ts
    │   ├── payments/                             # NEW vs core
    │   │   ├── payment.interface.ts             # IPaymentProvider: createSession, refund, verifyWebhook
    │   │   └── kashier/
    │   │       ├── kashier.client.ts             # raw Kashier v3 HTTP client
    │   │       ├── kashier.types.ts
    │   │       └── kashier.signature.ts          # HMAC verify
    │   └── utils/
    │       ├── time.utils.ts
    │       ├── money.ts                          # NEW vs core — minor-unit helpers (toMinor, fromMinor, sumMinor)
    │       └── retry.ts                          # NEW vs core — exponential backoff
    │
    └── database/
        └── migrations/                           # knex migrations (raw SQL inside up/down)
            ├── 20260418000010_create_payment_providers.ts
            ├── 20260418000020_create_orders.ts
            ├── 20260418000030_create_order_items.ts
            ├── 20260418000040_create_payment_sessions.ts
            ├── 20260418000050_create_transactions.ts
            ├── 20260418000060_create_restaurant_balances.ts
            ├── 20260418000070_create_deliveries.ts
            ├── 20260418000080_create_agent_presence.ts
            ├── 20260418000090_create_agent_earnings.ts
            ├── 20260418000100_create_idempotency_keys.ts
            └── 20260418000110_create_payment_webhook_events.ts
            # (no core_inbound_events migration — dedupe is Redis SETNX)
```

---

## Layer rules (enforced by reading)

```
       app/  ── may import lib, pkg
       lib/  ── may import pkg + lib/config; may NOT import app/<module>/* (modules wire their own classes via @Module providers/imports)
       pkg/  ── pure providers, NO imports from lib or app, NO env, NO global singletons, NO NestJS decorators
```

### What goes in `pkg/`

- **Provider implementations** that could be swapped (Redis, Kashier, future Stripe, future Kafka).
- **Pure utilities** with no Express, no NestJS, no env, no DI dependency.
- A `pkg/` file should be unit-testable with **only** its inputs.

Examples in this service:
- `pkg/cache/redis.ts` — raw Redis client wrapper.
- `pkg/payments/kashier/kashier.client.ts` — raw Kashier HTTP client.
- `pkg/utils/money.ts` — minor-unit helpers.

### What goes in `lib/`

- **NestJS-aware glue**: middleware, guards, interceptors, filters, env-driven config, AMQP module, WS gateway, sharded Knex provider, scheduled jobs.
- May import `pkg/` and `lib/config` (the `ConfigService`), but never `app/<module>/*` directly.

Examples:
- `lib/idempotency/idempotency.interceptor.ts` — Nest interceptor that pulls the cache provider from DI.
- `lib/jobs/archival.worker.ts` — `@Cron` job that copies year-old rows to the archive cluster, then deletes from hot.
- `lib/sharding/region-resolver.middleware.ts` — Nest middleware mapping requests to a region.
- `lib/websocket/ws.gateway.ts` — `@WebSocketGateway` attached to the HTTP server.

### What goes in `app/<module>/`

- Business logic, state machines, RBAC enforcement choices, error message dictionaries, request/response DTOs.
- One module per bounded context, wired as a NestJS `@Module`. Cross-module calls go through services exported by the other module (never another module's repository).

---

## Per-module file conventions

Same as core-service, plus the Response DTO deviation. Recap:

| File                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `<m>.module.ts`                       | `@Module({ imports, controllers, providers, exports })`. Imports other feature modules; lists the controller + service + repository providers; exports services that other modules will inject. |
| `<m>.controller.ts`                   | `@Controller('resources')`. Constructor-injects only the service. Uses `@Get`/`@Post`/`@Patch`/`@Delete`. Decorates with `@UseGuards(...)`, `@UseInterceptors(...)`, `@RequirePermissions(...)`. Returns a **Response DTO** — the global `SuccessInterceptor` wraps it. |
| `<m>.service.ts`                      | `@Injectable()`. Orchestrates repos and other services. Throws NestJS HTTP exceptions (`NotFoundException`, `ForbiddenException`, …) using messages from `<m>.constants.ts`. Owns transactions (`knex.db(region).transaction()` + explicit commit/rollback). |
| `repository/<m>.repository.ts`        | `@Injectable()`. Injects Knex via `@Inject('KNEX_CONNECTION')`. Has `<MODULE>_COLUMNS` const + private `toEntity(row)`. Mutating methods accept `trx?: Knex.Transaction`. |
| `entity/<m>.entity.ts`                | Plain class. Constructor takes `Partial<Entity>`. No DB knowledge, no decorators. |
| `dto/<verb>-<m>.dto.ts`               | `class-validator`-decorated request shape. |
| `dto/<m>.response.dto.ts`             | Response payload shape with static `from(entity, ...)` factory. **Money in minor units; ts in ISO 8601.** Order-service-specific (see `CLAUDE.md` §6). |
| `enums.ts`                            | string enums whose values match DB CHECK constraint values. |
| `<m>.constants.ts`                    | `MODULE_ERRORS = { ... } as const` error message dictionary; module-scoped column constants. |

---

## Comparison to core-service

| Concept                        | core-service       | order-service                                  |
| ------------------------------ | ------------------ | ---------------------------------------------- |
| Framework                      | NestJS 10          | NestJS 10 (same)                               |
| `app/` modules                 | yes                | yes (same shape)                               |
| `lib/` glue                    | yes                | yes + `core-client/`, `core-events/`, `messaging/`, `sharding/`, `websocket/`, `jobs/` |
| `pkg/` agnostic providers      | yes (`utils`)      | yes (`cache`, `messaging`, `payments`, `utils`) |
| `database/migrations/`         | yes                | yes (same path)                                |
| DTO files                      | request only       | **request + response** (CLAUDE.md §6)          |
| Knex provider                  | single `KNEX_CONNECTION` | sharded resolver bound to the same `KNEX_CONNECTION` token: `db(region)` / `dbArchive(region)` |
| WebSocket                      | deps installed but not wired | yes — gateway scaffold lands in Phase 0 |
| Sharding (per country)         | no                 | yes (`lib/sharding/`)                          |
| Async to other services        | no                 | **inbound only** via RabbitMQ (`lib/core-events/`); no outbound |
| Cross-service HTTP client      | no                 | yes (`lib/core-client/`, base in Phase 0)      |
| Background jobs                | no                 | yes (`lib/jobs/archival.worker.ts`, Phase 7)   |
| Read replicas                  | no                 | no (deferred)                                  |
