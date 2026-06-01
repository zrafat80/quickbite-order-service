# CLAUDE.md — Order & Payments Service Guidelines

These rules apply to the **`order-service`** microservice of the **QuickBite** platform. They mirror the conventions of `core-service` while adding constraints specific to this service (DTO responses, region-sharded Postgres, Redis caching, sync/async I/O with `core-service`, WebSocket live updates, Kashier v3 payment integration).

When in doubt, look at how `core-service` does it and follow that exact pattern. Deviate **only** where a deviation is documented here.

---

## 1. Mission of this service

This service owns the **transactional truth** of the platform:

- **Orders** — placement, lifecycle, history, restaurant operations.
- **Payments** — online (Kashier v3) and Cash on Delivery (COD), webhooks, refunds.
- **Deliveries** — assignment, agent presence, lifecycle, earnings.
- **Restaurant finance** — running balance and payouts (modeled as transactions).
- **Real-time updates** — WebSocket broadcast of order/delivery status changes.

It does **not** own: users, restaurants, branches, products, RBAC permission catalog. Those live in `core-service` and are consumed sync (HTTP) or via cached projections.

---

## 2. Tech stack (locked — do not deviate)

| Concern              | Library / Tool                                                                       |
| -------------------- | ------------------------------------------------------------------------------------ |
| Runtime              | Node.js + TypeScript (strict, decorators on, `emitDecoratorMetadata`)                |
| Framework            | **NestJS 10** on `@nestjs/platform-express` (Express under the hood; no Fastify)     |
| DI                   | NestJS providers — constructor injection, `@Injectable()`, `@Inject(TOKEN)` for non-class providers |
| Validation           | `class-validator` + `class-transformer` via the **global `ValidationPipe`**          |
| Config               | `@nestjs/config` with a `load`-style factory (e.g. `appConfig`); `ConfigService.get(...)` |
| DB driver            | `knex` over `pg` (raw query builder; **no TypeORM/Prisma** even though `@nestjs/typeorm` may appear in `package.json` deps) |
| Cache                | `@nestjs/cache-manager` + `@keyv/redis` (Redis backend)                              |
| Auth                 | `@nestjs/jwt` + `jsonwebtoken` (access in HTTP-only cookie `access_token`; same JWT shape as core) |
| Password hashing     | `bcrypt`                                                                             |
| Email                | `@nestjs-modules/mailer` + `nodemailer` + Handlebars templates (only if needed — most notifications are WS) |
| WebSocket            | `@nestjs/websockets` + `@nestjs/platform-socket.io` + `socket.io` + `@socket.io/redis-adapter` for cross-worker fan-out |
| Messaging            | **RabbitMQ** via `amqplib` (core → order async; **NEW vs core**)                     |
| API docs             | `@nestjs/swagger` mounted at `/api/docs/swagger`                                     |
| Logging              | Custom `DatabaseLoggerService` + `LoggingInterceptor` (writes a row per request to a `logs` table — same pattern as core) |
| Health               | `@nestjs/terminus` (`HealthModule` exposes `/api/health`)                            |
| Scheduling           | `@nestjs/schedule` (used by the archival worker)                                     |
| IDs                  | `uuid` v4 for client-facing order ids; `bigserial` for internal PKs                   |
| Payments             | Kashier v3 (Payment Sessions + Webhooks; **NEW vs core**)                            |
| Testing              | `jest` + `ts-jest` + `@nestjs/testing` (+ `supertest` for e2e)                       |

**Do not introduce new libraries** without justification. ORMs are forbidden — Knex query builder + raw SQL only, exactly like `core-service`.

---

## 3. Folder structure (mirrors `core-service`)

```
src/
  main.ts                       # bootstrap: helmet, cors, /api prefix, swagger, cookie-parser, global ValidationPipe, global filters, global SuccessInterceptor, enableShutdownHooks, listen
  app.module.ts                 # root module: imports CacheModule + ScheduleModule + ConfigModule + DatabaseModule + every feature module; registers global APP_FILTER, APP_INTERCEPTOR, RequestContextService; applies CorrelationMiddleware to all routes
  app/                          # business modules (one folder per bounded context)
    <module>/
      <module>.module.ts        # @Module({ imports, controllers, providers, exports })
      <module>.controller.ts    # @Controller('resources') + route methods
      <module>.service.ts       # @Injectable() — business logic, throws NestJS HttpException subclasses
      repository/<module>.repository.ts   # @Injectable() — Knex injected; <MODULE>_COLUMNS const + private toEntity(row)
      entity/<module>.entity.ts # plain class, no decorators
      dto/
        <module>.request.dto.ts  # class-validator-decorated request shape
        <module>.response.dto.ts # response payload shape (see §6 — order-service deviation)
      enums.ts                   # string enums whose values match DB CHECK constraints
      <module>.constants.ts      # MODULE_ERRORS error-message dictionary (+ any COLUMN constants the module owns)
  lib/                          # cross-cutting infrastructure (depends on app/, env, DI)
    cache/
      cache.interceptor.ts            # UnifiedCacheInterceptor — Redis-backed, scope-aware, stampede-safe
      cache-scope.decorator.ts        # @CacheScope('PUBLIC' | 'PRIVATE')
    config/
      app.config.ts                   # @nestjs/config factory; reads process.env, returns typed config tree
    context/
      request-context.service.ts      # AsyncLocalStorage holding correlationId + region for the request
    database.module.ts                # @Global() — exports KNEX_CONNECTION + DatabaseService
    database.providers.ts             # KNEX_CONNECTION factory provider (or sharded variant — see §8)
    database.service.ts               # OnApplicationShutdown — closes the pool
    decorators/
      permissions.decorator.ts        # @RequirePermissions(resource, action, allowSystemAdmin?)
    email/                            # @nestjs-modules/mailer wiring (rare in this service; keep parity with core)
    filters/
      http-exception.filter.ts        # global error envelope: { statusCode, isSuccess, message, data, correlationId, timestamp }
      database-error.filter.ts        # maps PG SQLSTATE codes (23505, 23503, 23502, 42703, 22001) to HTTP status
    idempotency/
      idempotency.interceptor.ts      # Redis (+ DB fallback) idempotency on annotated routes
      idempotency.decorator.ts        # @Idempotency({ strict: true })
    interceptors/
      success.interceptor.ts          # global response envelope; auto-hoists pagination `meta`
    logging/
      database-logger.service.ts      # writes structured logs to the `logs` table
      log.interface.ts
      logging.interceptor.ts          # captures request/response metadata into the logger
    middleware/
      correlation.middleware.ts       # x-correlation-id header → AsyncLocalStorage
      guards/
        jwtGuard.ts                   # reads cookies.access_token, populates req.user
        permissions.guard.ts          # consumes @RequirePermissions metadata, checks via PermissionCacheService
        restaurant-member.guard.ts    # req.user.restaurantId vs route param
        branch-access.guard.ts        # req.user.branchIds vs route param
        internal-api-key.guard.ts     # x-api-key shared-secret check (NEW vs core; for /internal/* routes)
        guard.constants.ts
    pagination/
      query-parser.ts                 # parsePaginationQuery + parseFilters (cursor-based)
      cursor-pagination.ts            # builds the cursor + meta payload
    types/
      express.d.ts                    # extends Request: user, correlationId, region
    # ─── NEW vs core (order-service-specific) ───
    websocket/                        # WS gateway scaffold (Phase 0)
      ws.gateway.ts                   # @WebSocketGateway, JWT handshake, channel rooms
      ws.module.ts
      ws.publisher.ts                 # services call this after a status transition commits
    sharding/                         # region resolver
      region-resolver.ts              # X-Region / cookie / query → req.region
      regions.ts                      # canonical list + helpers
    core-client/                      # sync HTTP client to core-service
      core-client.module.ts
      core.http-client.ts             # base wrapper: retry, correlation, errors
      branch.client.ts
      product.client.ts
      permission.client.ts
      address.client.ts
    core-events/                      # inbound async consumer (RabbitMQ): cache invalidation handlers
      core-events.module.ts           # @Module — wires consumer + handlers
      core-events.consumer.ts         # OnModuleInit / OnApplicationShutdown lifecycle
      handlers/
        product-stock-changed.handler.ts
        product-price-changed.handler.ts
        branch-deactivated.handler.ts
        branch-updated.handler.ts
        restaurant-suspended.handler.ts
        rbac-permissions-changed.handler.ts
    events/                           # outbound async publisher (RabbitMQ): transactional outbox + drainer
      events.module.ts                # @Module — wires outbox repo, broker, drain service
      event-types.ts                  # EVENT_TYPES routing-key constants (order.placed, order.rejected, order.delivered, payment.completed)
      events.types.ts                 # InsertOutboxInput, OutboxRow
      outbox.repository.ts            # insertOutboxEvent(s), claimBatch (FOR UPDATE SKIP LOCKED), markDispatchedBulk, markFailed
      order-events.broker.ts          # @Injectable publisher for `order.events` exchange (separate connection from inbound consumer)
      outbox-drain.service.ts         # @Cron('*/2 * * * * *') — iterates regions, claims batch, publishes, bulk-marks dispatched
    messaging/                        # AMQP connection + channel lifecycle (DI-registered)
      messaging.module.ts             # @Global() so consumers/publishers can inject the broker
      amqp.connection.ts              # OnModuleInit / OnApplicationShutdown — single connection
      topology.ts                     # exchange/queue/DLQ declarations (idempotent)
    jobs/                             # background workers (archival only in this milestone)
      archival.worker.ts              # @Cron via @nestjs/schedule — moves rows older than current year to the archive cluster
  pkg/                          # framework-agnostic, app-agnostic providers
    cache/
      cache.interface.ts
      redis.ts                        # raw ioredis wrapper (used by lib/cache and lib/idempotency)
    messaging/                        # NEW vs core
      message-broker.interface.ts     # IMessageBroker: connect, consume, publish
      rabbitmq/
        rabbitmq.client.ts            # amqplib wrapper — no Nest, no env, no app types
        rabbitmq.types.ts
    payments/                         # NEW vs core
      payment.interface.ts            # IPaymentProvider: createSession, refund, verifyWebhook
      kashier/
        kashier.client.ts             # raw Kashier v3 HTTP client
        kashier.types.ts
        kashier.signature.ts          # HMAC verify
    utils/
      time.utils.ts
      money.ts                        # NEW vs core — minor-unit helpers
      retry.ts                        # NEW vs core — exponential backoff
  database/
    migrations/                       # knex migrations (raw SQL inside up/down)
```

### `pkg/` vs `lib/` vs `app/` — strict layering

```
       app/  ── may import lib, pkg
       lib/  ── may import pkg + lib/config; may NOT import app/<module>/* (modules wire app/ classes themselves via @Module providers/imports)
       pkg/  ── pure providers, NO imports from lib or app, NO env, NO global singletons, NO @Injectable
```

- `pkg/` is **framework-agnostic** and **app-agnostic**. It exports interfaces and concrete providers (Redis client, Kashier HTTP client, money helpers). It must remain swappable and unit-testable in isolation. **No NestJS decorators** in `pkg/`.
- `lib/` wires `pkg/` to the app: Knex provider factory from config, Redis cache module, guards, filters, interceptors, AMQP consumer module. It uses NestJS (`@Injectable`, `@Module`, `@Global`) and reads from `ConfigService`, but should not contain business rules.
- `app/` contains business modules. Cross-module calls must go through services (never reach into another module's repository). Wiring happens through `@Module({ imports: [OtherModule] })` and exporting the service.

If you find yourself importing `app/...` inside `pkg/`, **stop and refactor**. If you find yourself importing `app/...` directly from `lib/`, prefer making it a module that the app's feature modules import, instead of cross-importing.

---

## 4. Naming conventions

### Files
- `kebab-case` for filenames, with **dotted role suffixes** matching core: `order.controller.ts`, `order.service.ts`, `order.repository.ts`, `order.module.ts`, `order.entity.ts`, `create-order.dto.ts`, `permissions.guard.ts`, `success.interceptor.ts`, `http-exception.filter.ts`, `correlation.middleware.ts`.
- One class per file; class name PascalCase + the same suffix (`OrderController`, `OrderService`, `OrderRepository`, `OrderModule`, `CreateOrderDTO`, `PermissionsGuard`, `SuccessInterceptor`).

### TypeScript
- `PascalCase` classes/types/enums.
- `camelCase` variables/methods.
- `UPPER_SNAKE` for module-level constants (e.g. `ORDER_COLUMNS`, `ORDER_ERRORS`) and DI string tokens (e.g. `'KNEX_CONNECTION'`, `'SHARDED_KNEX'`).

### Database (Postgres)
- Tables: plural, `snake_case` (`orders`, `order_items`, `restaurant_balances`).
- Columns: `snake_case`. Boolean prefixed with `is_`.
- Primary keys: `id BIGSERIAL` (use `BIGINT` for FK columns).
- Foreign key constraints: `fk_<child_table>_<column>` → e.g. `fk_orders_customer_id`.
- Indexes: `idx_<table>_<col>[_<col>...]` for btree; `idx_<table>_<col>_gist` for GIST.
- Unique constraints: `uq_<table>_<col>[_<col>...]`.
- Check constraints inline; enum-like columns use `TEXT NOT NULL CHECK(col IN (...))` to match the core pattern (avoid native PG enums except for currency, which already exists).
- Timestamps: `created_at`, `updated_at`, `<verb>_at` (e.g. `accepted_at`, `picked_at`, `delivered_at`). All `TIMESTAMP NOT NULL` unless modelling absence (use `TIMESTAMP NULL`).
- Money: `INT` storing minor units (cents/piasters). **Never `DECIMAL` for money on hot paths.** This deviates from the draft schema in `img_2.png` — see §7.

### Routes
- All routes live under the global prefix `/api` (set in `main.ts`).
- Plural resource nouns inside `@Controller(...)`: `@Controller('orders')`, `@Controller('payments')`, `@Controller('deliveries')`, `@Controller('agents')`.
- Sub-routes for relations: `@Controller('restaurants/:restaurantId/orders')` or nested route methods.
- `PATCH` for partial updates (single status endpoint per resource).

---

## 5. Module file conventions

Every module under `app/<module>/` follows the same skeleton (see `core-service/backend/src/app/restaurant/` for the canonical example):

1. **`<module>.module.ts`** — `@Module({ imports, controllers, providers, exports })`. Imports other feature modules by class (`UserModule`), not individual services. Lists controllers and providers (service + repository). Exports services that other modules will inject.
2. **`<module>.controller.ts`** — `@Controller('resources')`. Constructor-injects the service (and only the service). Methods are `async` (or sync) class methods, decorated with `@Get`/`@Post`/`@Patch`/`@Delete`. Validation is automatic via the global `ValidationPipe` — just type the parameter as your DTO (`@Body() body: CreateOrderDTO`). Apply guards/interceptors with decorators (`@UseGuards(JwtAuthGuard, PermissionsGuard)`, `@UseInterceptors(IdempotencyInterceptor)`). **Always return a Response DTO** (see §6); the global `SuccessInterceptor` wraps it in the envelope.
3. **`<module>.service.ts`** — `@Injectable()`. Constructor-injects repositories, other services, and `@Inject('KNEX_CONNECTION')` (or the sharded provider) when starting transactions. Throws NestJS HTTP exceptions (`NotFoundException`, `ForbiddenException`, `ConflictException`, `BadRequestException`, `UnauthorizedException`) using messages from `<module>.constants.ts`.
4. **`repository/<module>.repository.ts`** — `@Injectable()`. Injects Knex via `@Inject('KNEX_CONNECTION')` (or the sharded variant). Holds an `<MODULE>_COLUMNS` const for safe SELECTs and a private `toEntity(row)` mapper (snake_case → camelCase). Every mutating method accepts an optional `trx?: Knex.Transaction` and uses `const db = trx ?? this.knex;`. Repos never start their own transactions.
5. **`entity/<module>.entity.ts`** — plain class, constructor takes `Partial<Entity>`. No decorators. No DB knowledge. Allow simple invariants only (e.g. `isExpired()` like core's `password-reset.entity.ts`).
6. **`dto/<module>.request.dto.ts`** — `class-validator`-decorated request shape (`@IsString`, `@IsInt`, `@ValidateNested`, `@Type(() => Nested)`, etc.). Strict-TS non-optionals end with `!`. Reuse via `class-transformer` mappers and `class-validator-extended` `PartialType` is fine, but don't depend on Swagger decorators in the DTO file.
7. **`dto/<module>.response.dto.ts`** — **order-service deviation; see §6.** Response payload shape with a static `from(entity, ...)` factory.
8. **`enums.ts`** — string-valued enums; values match DB CHECK constraint values.
9. **`<module>.constants.ts`** — `MODULE_ERRORS` `as const` dictionary of stable error messages, referenced when throwing NestJS exceptions. Module-scoped string tokens or column constants live here too.

> **Required (not optional):** every controller / service / repository / client / gateway file must keep `interface X { ... }` and `type X = ...` declarations out of its body. Define them in a sibling `*.types.ts` file (e.g. `order.repository.types.ts`, `branch.client.types.ts`, `order.service.types.ts`) and import them. Repository input shapes, service-layer authenticated-user shapes, client request/response shapes, query-option bags — all live in `*.types.ts`. The class file imports them; consumers also import directly from `*.types.ts` (no re-exports through the class file).
>
> The only types allowed to live alongside class declarations are anonymous inline ad-hoc shapes used in a single method signature (`{from?: Date; to?: Date}` for one query helper). The moment a shape is named or used twice, move it.

---

## 6. Response DTOs — the rule that differs from core

In `core-service`, services and controllers return raw entities and let the `SuccessInterceptor` wrap them. **In this service, every HTTP response payload MUST be shaped by a Response DTO class** declared in `dto/<module>.response.dto.ts`.

Reasons:
1. Decouples the wire format from internal entities/DB columns.
2. Lets us evolve schemas without leaking column changes to clients.
3. Keeps OpenAPI/contract docs honest — Response DTOs are the single source of truth.
4. Avoids accidentally leaking sensitive columns (provider reference IDs, internal balances).

### Rules

- Response DTOs live in `dto/<module>.response.dto.ts` (one file may contain multiple DTOs).
- They are **plain classes** — no `class-validator` decorators (validation runs on the way in, not out). They may use `class-transformer` `@Expose`/`@Exclude` but the simpler pattern is a static `from(entity, ...)` factory:

  ```ts
  export class OrderResponseDTO {
      id!: string;
      status!: OrderStatus;
      subtotal!: number;
      deliveryFee!: number;
      currency!: Currency;
      createdAt!: string; // ISO
      items!: OrderItemResponseDTO[];

      static from(order: OrderEntity, items: OrderItemEntity[]): OrderResponseDTO {
          const dto = new OrderResponseDTO();
          dto.id = order.publicId;
          dto.status = order.status;
          // ... map only the fields you want exposed
          dto.items = items.map(OrderItemResponseDTO.from);
          return dto;
      }
  }
  ```

- Controllers must **always return a Response DTO** (or array of Response DTOs). Never return a raw entity — the `SuccessInterceptor` will happily wrap one but it leaks DB columns.

  ```ts
  @Get(':id')
  async getOrder(@Param('id') id: string): Promise<OrderResponseDTO> {
      const { order, items } = await this.orderService.findById(id);
      return OrderResponseDTO.from(order, items);   // SuccessInterceptor wraps → { statusCode, isSuccess, message, data: <dto> }
  }
  ```

- For **paginated** endpoints, return `{ data: dtos, meta: { cursor, limit, sortBy, sortOrder } }` — the `SuccessInterceptor` automatically hoists `meta` to the envelope's top level (see core's `lib/interceptors/success.interceptor.ts`).
- Money fields in Response DTOs are returned as **integer minor units** (e.g. `1500` for 15.00 EGP), with a `currency` field next to them. Do not pre-format or localize on the server.
- Timestamps in responses are **ISO 8601 strings in UTC** (`Date.toISOString()`).
- Never include `internal*`, `*_hash`, provider secrets, or internal numeric IDs that are not part of the public contract. The public order id is a **UUID** (`public_id`), not the bigserial PK.

---

## 7. Database design rules (full schema in `docs/database-design.md`)

### Money

- Stored as `INT` minor units. Currency held on the row (or derivable from the order's branch).
- The draft in `img_2.png` shows `decimal` for `subtotal`, `delivery_fee`, etc. **We replace this with `INT` minor units** because:
  - Decimal arithmetic in Knex returns strings → easy to mishandle.
  - Money math in JS over decimal strings is error-prone; integer math is exact.
  - Aggregation across millions of rows is faster.
- Display formatting is the client's job.

### Sharding

- Shard key: **country** (`eg`, `sa`, ...). One Postgres cluster per country.
- The shard key is referred to in code as `region` — it just happens to be a country code today. We keep the column named `region` so the router stays generic if we ever sub-shard a country later.
- Every sharded table includes `region TEXT NOT NULL` immediately after `id`.
- Cross-shard queries are **forbidden** in the hot path. Customer/restaurant/agent reads always include the region (resolved by `lib/sharding/region-resolver.ts` from `X-Region` header / cookie / query) so the shard router can pick the correct connection.
- See `docs/system-design.md` §Sharding and `lib/sharding/` for the resolver, plus §8 below for how the sharded Knex provider is wired into NestJS.

### Indexing

- Indexes are added **only to support a query that exists in code**. No speculative indexes.
- Each index in a migration must have a one-line comment naming the query path it supports (e.g. `-- supports GET /restaurant/orders?branchId=&status=`).
- Composite indexes follow the **(equality cols, then range col)** rule — e.g. `(branch_id, status, created_at DESC)` for the restaurant orders list.
- **No `N+1` queries.** When a service needs related rows, the repository must `JOIN` or batch-fetch with `whereIn`. If a controller maps over an array and calls a per-row repository function, that is a bug — fix it in the repository.
- For order lists with items, fetch orders first, then a single `whereIn('order_id', orderIds)` for items, then assemble in the service.

### Foreign keys

- **Every** FK gets a named constraint and a supporting index (Postgres does **not** auto-index FKs). Pattern: `fk_<table>_<col>` constraint + `idx_<table>_<col>` index.
- Cross-service FKs (e.g. to `users.id` in `core-service`) are **logical only** — there is no DB-level FK because the data lives in another database. We document the reference in the migration as a comment and rely on application-level checks plus the `core-client`.

### Soft delete

- Most order/payment data is **append-only** (audit trail). Use status transitions, not deletes. Where soft delete is needed, use `deleted_at TIMESTAMP NULL` and partial index `WHERE deleted_at IS NULL`.

### Archival

- Per the PRD, only the **current year**'s orders/payments are queryable from the hot DB. Older rows are moved to a **separate cold Postgres database per region** (`order_service_archive` cluster, one per region — same shard topology as the hot DB). The archival worker is implemented in this milestone — see `docs/implementation-plan.md` Phase 7.

### Transactions ledger — double-entry legs

- On delivery (`AssignmentService.settleDelivered`) we write **four** leg rows into `transactions` in the same trx as the `orders.status='delivered'` flip:
  - `commission`         — platform's cut of `delivery_fee`              (`src_acc_id = restaurantId`, `dst_acc_id = null` for platform)
  - `agent_earning`      — agent's share = `delivery_fee − commission`   (`dst_acc_id = agentId`)
  - `restaurant_credit`  — restaurant's share = `subtotal`               (`dst_acc_id = restaurantId`)
  - `service_fee`        — platform-collected service fee                (`dst_acc_id = null`; skipped when `order.serviceFee == 0`)
- These four sum to the original `charge` / `cod_collection` amount (= `order.total`). That is an invariant — any reconciliation tool can join `transactions` on `order_id` and assert the sum.
- `restaurant_balances` and `agent_earnings` are **denormalized projections** of the relevant leg rows, kept for fast reads / payout cycles.
- Every leg row is idempotency-keyed by `<type>:<order.publicId>` so a duplicate `settleDelivered` cannot double-insert.

### Refund legs / restaurant-credit endpoint (TODO)

- We intentionally do **not** reverse the per-order legs on refund yet. Refunds currently write a single `refund` row mirroring the original `charge` and stop there.
- `transactions.reason` (added with the legs migration) is reserved for refund-fault attribution — e.g. `restaurant_fault`, `customer_fault`, `system_fault`. Stamp it whenever a refund or adjustment is issued; existing refund flows will be updated to populate it.
- When that's wired, we'll add an internal endpoint that credits the restaurant balance back (i.e. re-emits a `restaurant_credit` adjustment leg + bumps `restaurant_balances`) **only** when `reason` indicates the restaurant was not at fault. Until that endpoint exists, do not invent ad-hoc balance adjustments inline — funnel everything through this single code path so the ledger stays the source of truth.

---

## 8. Cross-cutting infra

### Knex / sharding (deviation from core's single-connection model)

Core registers a single `KNEX_CONNECTION` provider (a factory in `lib/database.providers.ts`) inside a `@Global() DatabaseModule`. We do the **same**, but the factory returns a **sharded resolver** — a small object whose `db(region)` method returns the Knex instance for that shard, and `dbArchive(region)` returns the cold-cluster Knex.

```ts
// lib/database.providers.ts (sketch)
export const databaseProviders = [
  {
    provide: 'KNEX_CONNECTION',
    inject: [ConfigService],
    useFactory: async (cfg: ConfigService) => {
      const hot = buildPerRegionKnex(cfg, 'hot');
      const cold = buildPerRegionKnex(cfg, 'archive');
      return {
        db: (region: string) => hot[region] ?? throwUnknownRegion(region),
        dbArchive: (region: string) => cold[region] ?? throwUnknownRegion(region),
      };
    },
  },
];
```

Services and repositories inject it the same way as core injects its single Knex:

```ts
constructor(@Inject('KNEX_CONNECTION') private readonly knex: ShardedKnex) {}
// then: this.knex.db(region).transaction(...)
```

`DatabaseService` (lifecycle) calls `Knex.destroy()` on every per-region connection in `OnApplicationShutdown` — same shape as core's `DatabaseService`.

### Idempotency

- **Required** on all order-creating, payment-initiating, and assignment endpoints.
- Apply with the same primitives as core's `lib/idempotency/`: `@UseInterceptors(IdempotencyInterceptor) @Idempotency({ strict: true })` on the controller method.
- Idempotency keys are stored in Redis with a 24h TTL and **also** persisted in an `idempotency_keys` table for the critical write paths (`POST /orders`, `POST /payments/init`) so we survive Redis loss. The interceptor reads/writes both stores.

### Cache

- Read-heavy endpoints use the same primitives as core's `lib/cache/`: `@UseInterceptors(UnifiedCacheInterceptor) @CacheScope('PUBLIC' | 'PRIVATE')`. `PRIVATE` automatically scopes the cache key by `req.user.userId`.
- Cache invalidation: explicit `cacheManager.del(key)` calls in the service after mutating writes. Do **not** rely on TTL alone for user-facing data.
- **Per-region cache namespacing** (deviation): every key is prefixed with the region (`eg:order:123`). The cache module's key generator reads `req.region` from the resolver.

#### Branch-product projection — split meta vs stock

`BranchClient.getBranchProducts` does **not** cache a product as a single blob. It maintains two independent projections so that the hot, churn-prone field (stock) never busts the rest:

| key                                      | shape                                                | TTL  | invalidated by |
|------------------------------------------|------------------------------------------------------|------|----------------|
| `core:product:meta:<branchId>:<pid>`     | `{productId, name, price, imageUrl, isAvailable}`    | 1 h  | `product.price.changed`, `product.meta.changed` |
| `core:product:stock:<branchId>:<pid>`    | numeric stock as a string                            | 30 s | `product.stock.changed` |

Read path: try both keys per productId in parallel; if either is missing, fall through to a single core call that returns both halves and write them back independently. The function still returns a unified `CoreBranchProduct[]` so callers don't notice the split.

Event mapping in `lib/core-events/handlers/`:
- `product.stock.changed` → `cache.del(productStock(...))` only — leaves meta intact.
- `product.price.changed` → `cache.del(productMeta(...))` — price is part of meta.
- `product.meta.changed`  → `cache.del(productMeta(...))` — admin updated name/image/availability.

Core's contract: emit `product.meta.changed` whenever admin mutates `name`, `image_url`, or `is_available`. Stock and price already have their own events. If you add a new field to the meta projection here, you must coordinate with core to add it to the same event.

### Auth

- Same JWT contract as core (`req.user.userId`, `email`, `role`, `restaurantId?`, `restaurantRole?`, `branchIds?`).
- Same delivery: HTTP-only cookie `access_token`, verified by `JwtAuthGuard` (`lib/middleware/guards/jwtGuard.ts`), which sets `req.user` from the verified payload.
- Apply with `@UseGuards(JwtAuthGuard)` on controllers/methods.
- **Region** is **not** in the JWT. It comes from `X-Region` header / `region` cookie / `?region=` (precedence in that order, resolved by `lib/sharding/region-resolver.ts` — which is a NestJS middleware applied globally in `app.module.ts`). `"all"` is preserved so specific read endpoints can fan out; writes resolve to one concrete region.

### Internal service-to-service auth

- Shared-secret header `x-api-key`. Implemented as a guard `RequireInternalApiKeyGuard` in `lib/middleware/guards/internal-api-key.guard.ts` — plain equality against `configService.get('internal.apiKey')`.
- Do **not** invent parallel `internal/` modules. Each domain module owns its own internal routes inside its own controller (or a dedicated `<module>.internal.controller.ts` registered in the same module), prefixed `/internal/...` and decorated with `@UseGuards(RequireInternalApiKeyGuard)`.
- Service and repository method names must be caller-agnostic — **never** `findForInternal`, `getByIdInternal`, `reserveStockForInternal`. A `findById` is a `findById` regardless of who calls it. The route path or at most a controller method name may signal "internal"; underlying services/repos stay generic and reusable.

### RBAC

- This service does **not** maintain its own permissions catalog. It uses the same `PermissionsGuard` shape as core (consume `@RequirePermissions(resource, action)` metadata via `Reflector`), but resolves permissions from a **read-through Redis cache** populated from `core-service` via `lib/core-client/permission.client.ts`.
- Apply with `@UseGuards(JwtAuthGuard, PermissionsGuard) @RequirePermissions('orders', 'create')` on controllers.
- Permissions used in this service are namespaced `orders:*`, `payments:*`, `deliveries:*`. The seed for these lives in `core-service/.../migrations/` and is documented in `docs/business-logic/rbac.md`.

### Error handling

- Throw NestJS HTTP exceptions (`NotFoundException`, `ForbiddenException`, `ConflictException`, `BadRequestException`, `UnauthorizedException`, `InternalServerErrorException`). **Never** throw plain `Error`.
- Module-level error messages live in `<module>.constants.ts` as a single `MODULE_ERRORS = { ... } as const` dictionary, referenced when throwing: `throw new NotFoundException(ORDER_ERRORS.NOT_FOUND)`. Don't compose ad-hoc strings inline for cases that have a stable name.
- The global `HttpExceptionFilter` (in `lib/filters/`) shapes the error envelope (`{ statusCode, isSuccess: false, message, data: null, correlationId, timestamp }`), and the global `DatabaseErrorFilter` maps PG SQLSTATE codes (`23505` → 409, `23503` → 400, `23502` → 400, `42703` → 400, `22001` → 400) before they reach `HttpExceptionFilter`.

### Transactions

- Same explicit try/commit/catch/rollback pattern as core (`auth.service.ts`, `restaurant.service.ts`):
  ```ts
  const trx = await this.knex.db(region).transaction();
  try {
      await this.someRepo.write(..., trx);
      await this.anotherRepo.write(..., trx);
      await trx.commit();
      return result;
  } catch (err) {
      await trx.rollback();
      throw err;
  }
  ```
- Do **not** use `knex.transaction(async (trx) => {...})` callback form — it is inconsistent with core.
- The service owns the trx and passes it to every repo call in the unit of work. Repos accept `trx?: Knex.Transaction`; they `const db = trx ?? this.knex.db(region);` and **never** start their own trx.

### Validation

- Validation is automatic via the **global `ValidationPipe`** registered in `main.ts` with `{ whitelist: true, transform: true }` — exactly like core. Just type the controller parameter as a Request DTO (`@Body() body: CreateOrderDTO`) and the pipe validates + coerces.
- Path/query params: type them with the right primitive (`@Param('id', ParseIntPipe) id: number`) or, for the cursor pagination contract, use `parsePaginationQuery` and `parseFilters` from `lib/pagination/` exactly as core does.
- **There is no per-controller `validateBody` helper** — that was the old pre-Nest pattern.

### Async with `core-service` (inbound, RabbitMQ)

The inbound async path is **from `core-service` over RabbitMQ** for cache invalidation and authorization invalidation.

The wiring lives in `lib/messaging/` (AMQP connection + lifecycle) and `lib/core-events/` (consumer + handlers), both wired as NestJS modules. The connection is opened in `OnModuleInit` and closed in `OnApplicationShutdown` — same lifecycle pattern as `lib/database.service.ts`.

- Topology:
  - Topic exchange: `core.events` (durable, declared by core).
  - Consumer queue: `order-service.core-events` (durable, declared by this service).
  - Bindings: `product.#`, `branch.#`, `restaurant.#`, `rbac.#` (multi-word match — routing keys like `product.stock.changed` need `#`, not `*`).
  - DLQ: `order-service.core-events.dlq` for poison messages (routed via the queue's dead-letter-exchange).
- Events consumed (routing key = event type):
  - `product.stock.changed`, `product.price.changed` → invalidate `core:product:*` keys.
  - `branch.deactivated`, `branch.updated` → invalidate `core:branch:*` keys + reject-new-orders flag on `branch.deactivated`.
  - `restaurant.suspended` → invalidate `core:restaurant:*` keys + flag pending orders for review.
  - `rbac.permissions_changed` → invalidate `core:rbac:perms:*` keys.
- Delivery semantics: **at-least-once**. Manual ack after the handler commits. Duplicates are expected.
- Dedupe via Redis SETNX on `core-events:dedupe:<eventId>` (24h TTL): set-if-absent before dispatching the handler; if not fresh, ack and skip. Safe to expire because every handler is an idempotent cache invalidation.
- Authentication: AMQP credentials (per-service vhost user/pass from env). No HMAC on the wire — the broker is trusted.

### Async to `analytics-service` (outbound, RabbitMQ) — transactional outbox

Outbound async emission to `analytics-service` is implemented in this milestone via a **transactional outbox + drainer**. Services must **never** publish to RabbitMQ directly in the request path — publishing without an outbox can lose events on crash and is not acceptable. The wiring lives in `lib/events/`.

- **In-trx write (`OutboxRepository.insertOutboxEvent`)**: services append a row to `events_outbox` inside the same DB transaction as the domain write (e.g. order placement, status transition, payment completion). If the trx rolls back, the event row vanishes too — no orphan publishes.
- **Drainer (`OutboxDrainService`)**: a NestJS `@Cron('*/2 * * * * *')` job, one tick per 2s. For each region it opens a trx, claims a batch with `SELECT ... FOR UPDATE SKIP LOCKED` (so concurrent drainer workers in the same region never double-publish), publishes each row to the `order.events` exchange via `OrderEventsBroker`, and bulk-updates `dispatched_at = NOW()`. On publish failure: the row is marked (`attempts++`, `last_error`), the batch bails out, and the next tick retries.
- **Broker (`OrderEventsBroker`)**: a dedicated publisher with its **own RabbitMQ connection**, distinct from the inbound `core-events` consumer's connection — a publisher hiccup must not kill the consumer's channel.
- **Schema**: `events_outbox` is **per-shard** (no `region` column — each region's DB has its own copy; the row's region is implied by the cluster it lives in). `UNIQUE (event_id)` (UUID) so analytics can dedupe. Partial index `(id) WHERE dispatched_at IS NULL` keeps the claim scan cheap. Migration: `src/database/migrations/20260520000010_create_events_outbox.ts`.
- **Topology**:
  - Topic exchange: `order.events` (durable, declared by this service).
  - Analytics binds on `order.#, payment.#`.
- **Routing keys emitted** (defined in `lib/events/event-types.ts` — keep aligned with analytics' bindings):
  - `order.placed`
  - `order.rejected`
  - `order.delivered`
  - `payment.completed`
- **Delivery semantics**: at-least-once. Analytics must dedupe by `event_id`.
- **New event types**: add the routing key constant in `event-types.ts`, write the outbox row in the same trx as the domain write inside the service, and notify analytics owners so they bind it. Do **not** publish from the request path; do **not** start a separate trx for the outbox insert.

### Reliability requirement on `core-service`

Core must use the same **transactional outbox** discipline on its side for the inbound `core.events` stream: domain mutation and outbox row in the same DB trx; a core-side dispatcher drains to RabbitMQ with publisher confirms. Publishing directly in the request path without an outbox can lose events on crash and is not acceptable.

### WebSocket

- One `socket.io` server per region-pinned process, mounted on the same HTTP server via `@WebSocketGateway` (`lib/websocket/ws.gateway.ts`) using `@nestjs/platform-socket.io`. The Redis adapter (`@socket.io/redis-adapter`) fans out across workers in the region. The gateway **scaffold** lands in **Phase 0** so any module added later can publish without re-wiring infrastructure. Wiring of actual events into services happens in **Phase 6**.
- Channel naming: `customer:<userId>`, `restaurant:<restaurantId>`, `branch:<branchId>`, `agent:<agentId>`.
- Auth on connect: client passes the same access token (cookie or `?token=` query). The gateway's `handleConnection` verifies via the same JWT logic as `JwtAuthGuard`, then joins the socket to channels (`socket.join(channel)`) it is authorized for.
- Broadcasts are produced by services (via `WsPublisher`) after a status transition commits, and pushed via Redis Pub/Sub so all WS workers in the region receive it.

---

## 9. Performance & scale rules

This service is the **hot path**. The following are non-negotiable:

1. **No N+1 queries, and no per-iteration writes.** Repositories must batch — both reads (use `whereIn(...)` instead of looping `findById`) and writes (use a single multi-row `INSERT`, or a single `UPDATE ... FROM (VALUES ...)` instead of looping per-item updates inside a transaction). The rule is "one round-trip per logical operation, regardless of cardinality." Outbox emits, stock decrements/increments, status fan-outs, item inserts — all collapse to one query. If a method takes `items: T[]`, its implementation must NOT contain `for (const it of items) await trx(...).insert/update(...)`.
2. **Every query must be backed by an index.** Run `EXPLAIN` mentally before merging.
3. **No `SELECT *`**. Always list columns via `<MODULE>_COLUMNS` (matches core).
4. **No app-side joins** of data that lives in the same DB. Use SQL joins.
5. **Long-running work** (PDF generation, bulk emails, archival) goes to a background worker, not a request handler.
6. **Cache** read-heavy endpoints (restaurant order list filtered to `pending`, agent task list, branch presence) with `@CacheScope`. TTL chosen per use case, documented inline near the controller method.
7. **Idempotency** on every write endpoint that costs money or creates orders.
8. **Connection pool**: `DB_POOL_MAX` is per-shard. Default 10. Tune from benchmarks.
9. **Pagination is cursor-based**, never offset. Use `parsePaginationQuery` + `cursor-pagination` (already in `lib/pagination/`, ported from core).
10. **Hot writes** (order insert, payment status update) must complete in **< 200ms p95**.

---

## 10. Code style — what to avoid

- ❌ ORMs (TypeORM, Prisma) — even if `@nestjs/typeorm` shows up in `package.json`, **do not use it**. Knex query builder + raw SQL only.
- ❌ Returning entities from controllers — use Response DTOs (§6).
- ❌ Cross-module repository imports. Inject the other module's service via its module's `exports`, or move shared logic to `lib/`.
- ❌ Business logic in controllers. Controllers do: receive DTO (auto-validated by `ValidationPipe`) → call service → return Response DTO. The `SuccessInterceptor` does the rest.
- ❌ `try { ... } catch (e) { console.log }`. Always rethrow or convert to a NestJS HTTP exception with a `MODULE_ERRORS.*` message.
- ❌ Throwing plain `Error` from a service. Always a NestJS HttpException subclass.
- ❌ Custom `AppError` class. Use built-in NestJS exceptions; the message dictionary lives in `<module>.constants.ts`.
- ❌ `any` in service signatures. DTOs and entities everywhere.
- ❌ Silent failures in webhooks. Webhook handlers must persist their result (success/failure) so retries are deterministic.
- ❌ Mutating the input body or DTO inside a service. Treat them as read-only.
- ❌ Creating new env vars without adding them to `lib/config/app.config.ts`.
- ❌ NestJS decorators in `pkg/`. `pkg/` stays framework-agnostic.
- ❌ Per-controller `validateBody(...)` calls — validation is global via `ValidationPipe`.
- ❌ Inline named `interface` / `type` declarations inside controller / service / repository / client / gateway files. Move them to a sibling `*.types.ts` (see §5). Anonymous inline shapes used in a single method signature are fine; named shapes are not.

---

## 11. When implementing a new module

Follow this exact order — never skip ahead:

1. Migration (table + indexes + FKs + comments naming the supporting query).
2. Entity class.
3. Request DTO(s).
4. Response DTO(s) — order-service-specific (§6).
5. Repository class (`@Injectable()`).
6. Service class (`@Injectable()`).
7. Controller class (`@Controller`).
8. Module class (`@Module({ imports, controllers, providers, exports })`).
9. Add the module to `app.module.ts` `imports`.
10. Smoke test the endpoint manually before moving on.

Implement one module end-to-end before starting the next. Order: **orders → payments → deliveries → agents → restaurant-finance → websocket integration → archival worker**. See `docs/implementation-plan.md`.

---

## 12. Reference docs (in `docs/`)

- `docs/database-design.md` — full schema, FK map, indexes, sharding plan.
- `docs/system-design.md` — region sharding, redis layers, sync/async flows, kashier, websocket, archival.
- `docs/folder-structure.md` — annotated tree, layer rules.
- `docs/api-contracts.md` — endpoint-by-endpoint request/response DTOs and error codes.
- `docs/business-logic/` — one file per module describing flows, invariants, RBAC, status machines.
- `docs/implementation-plan.md` — step-by-step build order with acceptance checks.

---

## 13. Out of scope (do not build)

- The `analytics-service` itself (separate service, future) — this service emits to it via the `order.events` exchange (see §8), but the consumer side is not built here.
- DevOps / deploy infra, observability stack, benchmark/perf testing — separate effort, future.
- Read replicas — single primary per region for now; revisit when traffic justifies it.
- Recommendations, loyalty, AI delivery optimization, reviews (PRD §13).
- Payouts as a separate table — payouts are modeled as a `transaction_type` in the `transactions` table.
- Incentives / promo codes (explicit user instruction).
