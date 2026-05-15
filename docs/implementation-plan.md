# Implementation Plan — `order-service`

Sequenced build order. **Every module is built end-to-end (migration → entity → DTOs → repo → service → controller → routes → mount) before the next module begins.** That keeps every checkpoint shippable and testable.

Acceptance for each phase: the relevant endpoints respond with the documented contract on a local Postgres + Redis stack, idempotency works, RBAC denies the right calls, and (where applicable) WebSocket clients receive the documented events.

> **Parallel work on `core-service`.** This service depends on new endpoints, new RBAC permissions, a new API-key / HMAC auth guard, and an outbound webhook publisher on `core-service`. Each phase below has a **"Core-service changes required"** section. Do not start a phase until its core-service counterpart is in place.

---

## Phase 0 — Scaffolding (no business logic)

Goal: a runnable NestJS app with the same conventions as `core-service` plus the new infra (country sharding, WS gateway, core-client, RabbitMQ consumer for inbound core events). No domain modules yet. Anything later phases might need is installed here so they only write business code.

### 0.1 Project bootstrap

1. `package.json` — copy core's deps (NestJS 10 + `@nestjs/platform-express`, `@nestjs/config`, `@nestjs/cache-manager` + `@keyv/redis`, `@nestjs/jwt`, `@nestjs/swagger`, `@nestjs/terminus`, `@nestjs/schedule`, `@nestjs/websockets` + `@nestjs/platform-socket.io`, `socket.io`, `class-validator`, `class-transformer`, `knex`, `pg`, `bcrypt`, `jsonwebtoken`, `cookie-parser`, `helmet`, `uuid`, `jest` + `ts-jest` + `@nestjs/testing`, `supertest`). Add `amqplib` (+ `amqp-connection-manager`) and `@socket.io/redis-adapter` on top. No new lockfile beyond what's required.
2. `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json` — copy core verbatim.
3. `.env` & `.env.example`:
   ```
   PORT=4000
   ACCESS_SECRET=...                  # MUST match core
   REFRESH_SECRET=...
   DB_MIGRATION_DIRECTORY=src/database/migrations
   DB_MIGRATION_EXTENSION=ts
   REGIONS=eg,ksa
   DB_eg_HOST=localhost
   DB_eg_PORT=5432
   DB_eg_USERNAME=postgres
   DB_eg_PASSWORD=...
   DB_eg_NAME=order_service_eg
   DB_ksa_HOST=...
   DB_ksa_PORT=5432
   DB_ksa_USERNAME=postgres
   DB_ksa_PASSWORD=...
   DB_ksa_NAME=order_service_ksa
   DB_POOL_MAX=10
   # archive cluster — same shape, separate hosts; used starting Phase 7
   ARCHIVE_DB_eg_HOST=...
   ARCHIVE_DB_eg_NAME=order_service_archive_eg
   ARCHIVE_DB_ksa_HOST=...
   ARCHIVE_DB_ksa_NAME=order_service_archive_ksa
   REDIS_HOST=localhost
   REDIS_PORT=6379
   # RabbitMQ (inbound core events)
   RABBITMQ_URL=amqp://order-service:<secret>@localhost:5672/quickbite
   RABBITMQ_CORE_EVENTS_EXCHANGE=core.events
   RABBITMQ_CORE_EVENTS_QUEUE=order-service.core-events
   RABBITMQ_CORE_EVENTS_BINDINGS="product.#,branch.#,restaurant.#,rbac.#"
   RABBITMQ_CORE_EVENTS_DLX=core.events.dlx
   RABBITMQ_CORE_EVENTS_DLQ=order-service.core-events.dlq
   RABBITMQ_PREFETCH=32
   # core-service integration
   CORE_SERVICE_BASE_URL=http://localhost:3000
   CORE_INTERNAL_API_KEY=...            # sent on every outbound sync call to core
   # kashier
   KASHIER_BASE_URL=https://api.kashier.io
   KASHIER_MERCHANT_ID=...
   KASHIER_API_KEY=...
   KASHIER_WEBHOOK_SECRET=...
   KASHIER_RETURN_URL=https://app.quickbite.io/checkout/return
   KASHIER_FAIL_URL=https://app.quickbite.io/checkout/failed
   PAYMENT_SESSION_TIMEOUT_MIN=15
   # deliveries/assignment
   ASSIGNMENT_RADIUS_METERS=5000
   AGENT_ACCEPT_TIMEOUT_SEC=30
   MAX_REASSIGNMENT_ATTEMPTS=3
   PRESENCE_STALE_SEC=90
   # websocket
   WS_HEARTBEAT_SEC=30
   ```
4. `src/lib/config/app.config.ts` — `@nestjs/config` factory function (registered via `ConfigModule.forRoot({ isGlobal: true, load: [appConfig] })` in `app.module.ts`); returns a typed config tree covering all of the above. Parses `REGIONS` and builds the per-region DB triples (hot + archive).

### 0.2 Copy-from-core infra (verbatim unless noted)

5. `src/lib/filters/http-exception.filter.ts`, `database-error.filter.ts` — copy core. Provide the global error envelope and the PG SQLSTATE → HTTP mapping. Registered globally in `app.module.ts` via `APP_FILTER`.
6. `src/lib/logging/database-logger.service.ts`, `log.interface.ts`, `logging.interceptor.ts` — copy core (writes a row per request to a `logs` table).
7. `src/lib/middleware/correlation.middleware.ts` + `src/lib/context/request-context.service.ts` — AsyncLocalStorage-backed correlation id; the middleware is applied to all routes via `app.module.ts`'s `MiddlewareConsumer`.
8. `src/lib/interceptors/success.interceptor.ts` — global response envelope `{ statusCode, isSuccess, message, data, [meta] }`. Registered via `APP_INTERCEPTOR` in `app.module.ts`.
9. `src/lib/pagination/query-parser.ts`, `cursor-pagination.ts` — `parsePaginationQuery` + `parseFilters` + cursor encode/decode. Validation is global via `ValidationPipe` registered in `main.ts` (`{ whitelist: true, transform: true }`); there is no per-controller `validateBody` helper.
10. `src/lib/types/express.d.ts` — **extend** Request with `region?: string` and `user?` (no `region` claim on `user`).
11. `src/pkg/cache/cache.interface.ts`, `redis.ts`.
12. `src/pkg/utils/time.utils.ts`. **Add** `money.ts` (`toMinor`, `fromMinor`, `sumMinor`) and `retry.ts` (exponential backoff).
13. `src/lib/cache/cache.interceptor.ts` (`UnifiedCacheInterceptor`), `cache-scope.decorator.ts` (`@CacheScope('PUBLIC' | 'PRIVATE')`) — copy core. Redis backend wired via `CacheModule.registerAsync({ isGlobal: true, useFactory: ... stores: [createKeyv(REDIS_URL)] })` in `app.module.ts`.
14. `src/lib/middleware/guards/jwtGuard.ts`, `permissions.guard.ts`, `restaurant-member.guard.ts`, `branch-access.guard.ts`, `guard.constants.ts` + `src/lib/decorators/permissions.decorator.ts` — copy core. JWT secrets match so tokens issued by core are accepted here.
15. `src/lib/idempotency/idempotency.interceptor.ts`, `idempotency.decorator.ts` — copy core. Leave the DB-fallback hook disabled until the `idempotency_keys` table lands in Phase 1.
16. *(No DI container — modules wire their own classes via `@Module({ controllers, providers, exports })`.)*

### 0.3 New infra (sharding, core-client, RabbitMQ consumer, WS)

17. `src/lib/sharding/sharding.module.ts` + `regions.ts` — canonical country list (from `ConfigService`), helpers `isRegion(s)`.
18. `src/lib/sharding/region-resolver.middleware.ts` — Nest middleware that sets `req.region` from the **`X-Region` header** only (no path/query/cookie/JWT fallback). `req.region = "all"` is allowed only for admin fan-out reads; writes require a concrete region. Throws `BadRequestException` (`REGION_NOT_RESOLVED`) when unresolved. Wired in `app.module.ts` via the `MiddlewareConsumer`.
19. `src/lib/sharding/shards.ts` — builds `Map<region, Knex>` lazily for the **hot** cluster, and a parallel `Map<region, Knex>` for the **archive** cluster (consumed only in Phase 7; the slot is created now to avoid re-wiring later).
20. `src/lib/database.module.ts` — `@Global() @Module({...})` exporting `KNEX_CONNECTION` + `DatabaseService`.
    `src/lib/database.providers.ts` — `KNEX_CONNECTION` factory provider returning `{ db(region), dbArchive(region), pingAll() }`. Reads per-region triples from `ConfigService` and uses `lib/sharding/shards.ts` to build the maps.
    `src/lib/database.service.ts` — `OnApplicationShutdown` destroys every per-region pool (hot + archive).
21. `knexfile.ts` at the repo root — base config used by the Knex CLI; wraps a script `npm run migrate:all` that iterates regions.
22. `src/lib/core-client/core-client.module.ts` + `core.http-client.ts` — **base** HTTP client as a Nest provider (uses `fetch` or `@nestjs/axios`):
    - Sets `x-api-key: ${configService.get('core.internalApiKey')}` header on every request.
    - Forwards `X-CorrelationId` from `RequestContextService`.
    - Retries 3x with exponential backoff on 5xx / network errors, capped at 500ms.
    - Translates non-2xx to a NestJS `HttpException` subclass.
    - **Does not** yet import any endpoint wrappers — those (branch/product/permission/address clients) are added in their respective module phases. This file is the only addition in Phase 0.
23. `src/pkg/messaging/message-broker.interface.ts` — `IMessageBroker { connect, consume, close, declareTopology, publish }`. App-agnostic, **no NestJS imports**.
    `src/pkg/messaging/rabbitmq/rabbitmq.client.ts` — wraps `amqp-connection-manager`: auto-reconnect, publish buffering on disconnect, topology re-declaration on reconnect. No hand-rolled backoff loop.
24. `src/lib/messaging/messaging.module.ts` + `amqp.connection.ts` — `@Global()` Nest module wrapping the `pkg/messaging` client. `OnModuleInit` opens the connection (`amqp-connection-manager`-based `RabbitMQClient`); `OnApplicationShutdown` closes it. Topology (`core.events` exchange, `order-service.core-events` durable queue with DLX args, bindings, DLQ) is declared inline by the core-events consumer at boot — no separate `topology.ts`.
25. `src/lib/core-events/core-events.module.ts` + `core-events.consumer.ts` — Nest module whose `OnModuleInit` starts the AMQP consumer loop:
    - On each message: `cache.trySet("core-events:dedupe:<eventId>", "1", 86400)` — SETNX in Redis.
    - If not fresh (key already exists) → ack, skip.
    - Else dispatch to a registry: `handlers[eventType](payload)`. Registry starts empty; modules register handlers in later phases.
    - On success → ack.
    - On handler throw → nack with `requeue=false` (message flows to DLQ).
26. `src/lib/core-events/types.ts` — `CoreEventEnvelope`, `CoreEventHandler` type alias `(payload) => Promise<void>`. No SQL log repo.
27. `src/lib/websocket/` — **socket.io gateway scaffold** (using `@nestjs/websockets` + `@nestjs/platform-socket.io`):
    - `ws.module.ts` — Nest module; provides `WsGateway` and `WsPublisher`.
    - `ws.gateway.ts` — `@WebSocketGateway({ path: '/ws' })`. `afterInit` installs `@socket.io/redis-adapter` using the shared Redis client (+ a duplicate for the subscriber). `handleConnection` validates the JWT (cookie or `?token=` query) via `ws-auth.ts` and joins the socket to its permitted rooms.
    - `ws-auth.ts` — JWT verify + permitted-room derivation (`customer:<userId>`, `restaurant:<restaurantId>`, `branch:<branchId>` per branch, `agent:<agentId>`).
    - `ws.publisher.ts` — `@Injectable()` exposing `emit(channel, event, payload)`. Services inject this rather than reaching into the `io` server directly. Cross-worker fan-out is handled by the Redis adapter.
    - `ws-errors.ts` — `WsNoTokenError` etc.
28. `src/app/health/health.module.ts` + `health.controller.ts` — `GET /api/health` calls the database provider's `pingAll()` (hot clusters only for now). Use `@nestjs/terminus`, same as core.
29. `app.module.ts` imports `HealthModule` (no `src/routes.ts` — controllers self-mount via `@Controller`). No inbound HTTP webhook route — core→order traffic is RabbitMQ.
30. `src/main.ts`, `src/app.module.ts` — copy core. `app.module.ts` additionally imports `DatabaseModule`, `ShardingModule`, `MessagingModule`, `CoreEventsModule`, `WsModule`. `main.ts` calls `app.enableShutdownHooks()` so `OnApplicationShutdown` hooks on `DatabaseService`, the AMQP connection, and the WS gateway all close cleanly.

### 0.4 No migrations in Phase 0

Phase 0 creates no tables. Core-event dedupe lives in Redis; all domain tables land in the phase that consumes them.

### 0.5 `core-service` changes required before Phase 0 ships

These belong on `core-service` and must land before this service's Phase 0 is considered complete.

1. **Seed new RBAC permissions** (new migration in `core-service/backend/src/database/migrations/`):
   ```sql
   INSERT INTO permissions (resource, action, created_at) VALUES
     -- Orders
     ('orders',     'read',   NOW()),
     ('orders',     'accept', NOW()),
     ('orders',     'update',        NOW()),
     ('orders',     'cancel',        NOW()),
     -- Payments
     ('payments',   'read',          NOW()),
     ('payments',   'refund',        NOW()),
     -- Deliveries (admin-only)
     ('deliveries', 'assign',        NOW()),
     -- Finance
     ('finance',    'read',          NOW()),
     ('finance',    'payout_create', NOW())
   ON CONFLICT (resource, action) DO NOTHING;
   ```
   Role mapping (extend the existing seed):
   - `owner` → all of the above.
   - `branch_manager` → `orders:read, orders:accept, orders:update, orders:cancel, finance:read`.
   - `staff` → `orders:read, orders:update, orders:accept`.
   - `payments:refund` and `finance:payout_create` are admin-bypassed today; seeded for future extensibility.

2. **Add `restaurant_branches.delivery_fee INT NOT NULL DEFAULT 0`** (minor units of the branch currency) in core. This service reads it via `GET /api/internal/branches/:id` at checkout.

3. **Internal API-key auth guard** (for sync HTTP calls **from** this service **to** core):
   - New env on core: `INTERNAL_API_KEY=<secret>` (single shared secret). Matched by `CORE_INTERNAL_API_KEY` on this service's side.
   - New guard `src/lib/middleware/guards/internal-api-key.guard.ts` (`RequireInternalApiKeyGuard`) that compares the `x-api-key` request header against `configService.get('internal.apiKey')` (plain equality — the broker/gateway is the trust boundary).
   - Each domain module mounts its own internal routes inside its own controller (or a dedicated `<module>.internal.controller.ts` registered in the same `@Module`) under the `/internal/...` prefix, decorated with `@UseGuards(RequireInternalApiKeyGuard)`. There is **no** dedicated `app/internal/` module.

4. **Transactional outbox on core** (`src/lib/events/` in core):
   - New env on core: `RABBITMQ_URL`, `RABBITMQ_CORE_EVENTS_EXCHANGE=core.events`, `OUTBOX_DRAIN_CRON="* * * * * *"`, `OUTBOX_BATCH_SIZE=50`.
   - New migration: `events_outbox` table on core's DB (`id, aggregate_type, aggregate_id, event_type, event_id, payload JSONB, created_at, dispatched_at, attempts, last_error`).
   - **Service layer** (never repo) writes the outbox row in the same DB transaction as the domain write. Repos never call `insertOutboxEvent`.
   - The drain lives in a **separate worker process** (`src/worker.ts`), not in the API. `croner` schedules `drainOutbox()`; `drainOutbox` claims a batch with `FOR UPDATE SKIP LOCKED`, publishes with **publisher confirms**, stamps `dispatched_at` on broker ACK. SKIP LOCKED makes N workers safe in parallel.
   - The `core.events` topic exchange is declared by the worker at boot.

5. **Secrets hygiene**: `KASHIER_WEBHOOK_SECRET` (this service), `INTERNAL_API_KEY` (one shared secret between core and order-service today), and RabbitMQ credentials are three different secrets with three different lifecycles. Do not conflate them.

### Acceptance (Phase 0)

- `npm run start:dev` starts, `GET /api/health` returns OK against every configured shard.
- On boot, the `core-events` consumer declares the queue + bindings + DLQ and begins consuming. Publishing a test message to `core.events` with routing key `product.test` (unregistered type) is consumed, logged as "no handler, acking", and acked — unknown types are not sent to DLQ.
- Killing RabbitMQ and restarting this service: `amqp-connection-manager` reconnects automatically and re-declares topology; no crash.
- On the core side, `npm run worker:dev` boots the outbox worker; inserting a row into `events_outbox` is drained within ~1s and shows up in this service as a Redis dedupe key `core-events:dedupe:<eventId>`.
- A socket.io client connects to `ws://localhost:4000` with `path: "/ws", auth: {token}`, emits `subscribe(channel, ack)`, and a server-side `io.to(channel).emit(event, payload)` reaches the client.

---

## Phase 1 — Orders module (the spine)

### Migrations

- `20260418000020_create_orders.ts`
- `20260418000030_create_order_items.ts`
- `20260418000100_create_idempotency_keys.ts`

### Code

1. Migrations above (each in every region).
2. Entities: `OrderEntity`, `OrderItemEntity`.
3. Request DTOs: `CreateOrderRequestDTO`, `UpdateOrderStatusRequestDTO`, query DTOs (or use `parsePaginationQuery`).
4. Response DTOs: `OrderResponseDTO`, `OrderItemResponseDTO`, `OrderSummaryResponseDTO`, `OrderDetailResponseDTO`, `OrderStatusResponseDTO`.
5. Repositories (`@Injectable()` classes):
   - `order.repository.ts` — `createOrder`, `findOrderByPublicId`, `findOrdersByCustomer`, `findOrdersByBranch`, `updateOrderStatus`, `setDeliveryAgent`. Each accepts `trx?: Knex.Transaction`; the body uses `const db = trx ?? this.knex.db(region);`.
   - `order-item.repository.ts` — `bulkInsertItems`, `findItemsByOrderIds(orderIds[])` (batch — guards against N+1).
   - `idempotency-store.ts` — `tryGet`, `store`. Activate the DB-fallback hook in `lib/idempotency/idempotency.interceptor.ts` now that the table exists.
6. `order-status.service.ts` — pure helper: `assertTransition(from, to, actor)` table-driven from `enums.ts`.
7. `order.service.ts` —
   - `placeOrder(...)` per Orders.md §2 (validate via core-client cached → compute money → trx → after-commit reserveStock).
   - `getOrder(...)`: by publicId; ownership check; loads items batch + payment summary (joins).
   - `listCustomerOrders(...)`, `listRestaurantOrders(...)` with cursor pagination.
   - `updateStatus(...)`: validates transition, stamps timestamp, publishes WS (WS publisher is wired; events are emitted but the client wiring test moves to Phase 6).
8. `order.controller.ts` — type request bodies as DTOs (auto-validated by the global `ValidationPipe`); return Response DTO instances (the global `SuccessInterceptor` wraps them). For paginated endpoints, return `{ data: dtos, meta }`.
9. Apply guards/interceptors via decorators on controller methods: `@UseGuards(JwtAuthGuard, PermissionsGuard)` + `@RequirePermissions('orders', ...)`; `@UseInterceptors(IdempotencyInterceptor) @Idempotency({ strict: true })` on `POST /orders`; `@UseInterceptors(UnifiedCacheInterceptor) @CacheScope('PUBLIC')` (10s TTL) on `GET /restaurant/orders` per branch+status.
10. `order.module.ts` — `@Module({ imports, controllers: [OrderController], providers: [OrderService, OrderStatusService, OrderRepository, OrderItemRepository], exports: [OrderService] })`. Add `OrderModule` to `app.module.ts`'s `imports`.
11. **Core-client endpoint wrappers added now**:
    - `branch.client.ts` — `getBranch`, `getBranchProducts(branchId, productIds[])`, `reserveStock(branchId, items[])`.
    - `address.client.ts` — `getCustomerAddress(id)`.
12. **Register core-event handlers** (in the Phase 0 consumer registry):
    - `product.stock.changed` → invalidate `core:product:price:*` and `core:product:stock:*` for the affected branch+product.
    - `product.price.changed` → invalidate `core:product:price:<branchId>:<productId>`.
    - `branch.updated` / `branch.deactivated` → invalidate `core:branch:<branchId>`; `branch.deactivated` additionally sets a Redis flag that the orders service checks to reject new orders to that branch.
    - `restaurant.suspended` → invalidate `core:restaurant:<id>`; mark pending orders for that restaurant for review.

### Core-service changes required

All of the following go under `/api/internal/*` (guarded by the API-key middleware from Phase 0) unless noted.

- `GET /api/internal/branches/:id` — branch metadata: `{ id, region, restaurantId, restaurantStatus, acceptOrders, isActive, deliveryFee, commissionBps, currency, lat, lng, name, addressText }`. Lives on the branch module's router (inline internal route).
- `GET /api/internal/branches/:id/products?ids=1,2,3` — batch price + stock + availability + name + image URL for the requested product IDs. Lives on the product module's router.
- `POST /api/internal/branches/:id/reserve-stock` — body `{ items: [{ productId, quantity }] }`. Atomic decrement inside one core-service DB trx; returns 409 with offending items on underflow. Idempotent via `Idempotency-Key`. Lives on the product module's router.
- `GET /api/internal/customer-addresses/:id` — returns `{ id, userId, lat, lng, addressText, city, country, building, apartmentNumber, label }` for the delivery snapshot. Lives on the customer-address module's router.
- `GET /api/internal/agents/:id` — returns `{ id, name, phone }` for an agent. Lives on the user module's router.
- `GET /api/internal/rbac/permissions?role=<name>` — returns the permission list for a role (used by the RBAC cache). Lives on the rbac module's router.
- **Wire outbox inserts in the service layer** (never the repo): in the same DB trx as every mutation to `products`, `product_branch_details`, `restaurant_branches`, `restaurants` and `role_permissions`, the owning service calls `insertOutboxEvent(trx, ...)` with the corresponding `event_type` — `product.stock.changed`, `product.price.changed`, `branch.updated`, `branch.deactivated`, `restaurant.suspended`, `rbac.permissions_changed`. The worker process drains and publishes to `core.events`.

### Acceptance

- `POST /orders` with COD creates an order, returns 201, items are persisted.
- Same idempotency key returns the same response; different body → 409.
- `PATCH /orders/{id}/status` accept→preparing→ready works; reject from preparing fails; customer cancel after `accepted_at + 60s` fails.
- `GET /restaurant/orders?branchId=&status=placed` returns expected list; `EXPLAIN` shows index usage.
- Triggering `product.stock.changed` in core (service mutation → outbox insert in same trx → worker drains → `core.events`) is consumed here and deletes the right Redis keys. Replay of the same `eventId` is a no-op (dedupe via Redis SETNX on `core-events:dedupe:<eventId>`).

---

## Phase 2 — Payments module

### Migrations

- `20260418000010_create_payment_providers.ts` (with seed `kashier`, `cod`).
- `20260418000040_create_payment_sessions.ts`.
- `20260418000050_create_transactions.ts`.
- `20260418000110_create_payment_webhook_events.ts`.

### Code

1. Kashier provider in `pkg/`:
   - `pkg/payments/payment.interface.ts` (`createSession`, `refund`, `verifyWebhook`).
   - `pkg/payments/kashier/kashier.client.ts` — HTTP client for Kashier v3.
   - `pkg/payments/kashier/kashier.signature.ts` — HMAC.
   - `pkg/payments/kashier/kashier.types.ts` — provider DTOs.
2. Entities: `PaymentSessionEntity`, `TransactionEntity`, `PaymentProviderEntity`.
3. Request DTOs: `InitPaymentRequestDTO`, `RefundRequestDTO`.
4. Response DTOs: `PaymentInitResponseDTO`, `PaymentResponseDTO`.
5. Repositories (`@Injectable()`): `payment-session.repository.ts`, `transaction.repository.ts`, `payment-webhook-event.repository.ts`, `payment-provider.repository.ts`.
6. `kashier-webhook.service.ts` — verify signature, dedupe by `(provider_id, provider_event_id)`, advance session/transaction/order in trx.
7. `payment.service.ts` — `init`, `getById`, `refund`.
8. Controllers: `payment.controller.ts` (`@UseGuards(JwtAuthGuard)`) and `payment-webhook.controller.ts` (no guard — webhook signature verification handled inside the handler).
9. Routes: `POST /payments/init`, `POST /payments/webhook/:provider` (no auth), `GET /payments/:id`, `POST /payments/:id/refund`. `@UseInterceptors(IdempotencyInterceptor) @Idempotency({ strict: true })` on init and refund.
10. `payment.module.ts` — register the controllers, services, repositories; add to `app.module.ts`'s `imports`.
11. **Cross-module update** in Orders: on `paymentMethod='online'`, optionally invoke `PaymentService.init` (inject the service via `PaymentModule`'s `exports`) to attach the `redirectUrl` on the `POST /orders` response. Clients may also call `POST /payments/init` separately.

### Core-service changes required

- None strictly required for this phase. If we want core to be notified of `payment.refunded` or `payment.captured` later, that's a separate change; we don't emit anything outbound in this milestone.

### Acceptance

- `POST /payments/init` creates a Kashier session (mock in tests), persists `payment_sessions`.
- Webhook end-to-end: signed payload → order moves to `placed`, transaction recorded. Duplicate webhook → 200 with no side effect.
- Refund flow: POST → Kashier mock 2xx → transaction `pending` → simulated webhook → `succeeded`, charge marked `is_refunded`.

---

## Phase 3 — Deliveries + Agents (compressed)

> **Compressed from the original Phase 3 + Phase 4.** Per the agreed DB design (PNG `img_2.png`) there is **no `deliveries` table** — the order's existing status machine (`assigned → picked → delivered`) plus `orders.delivery_agent_id` already covers the per-order delivery state. The only audit we lose is the reassignment chain, which we replace with a counter on `orders` (per user decision: counter-only, no per-attempt audit table). Reasons for compression: agents and deliveries share the assignment/settlement loop end-to-end and shipping them apart would force a temporary Postgres-only assignment scaffold that's thrown away one phase later.
>
> **Commission is deferred to Phase 5 (finance).** The `orders.commission` column stays at `0` and the settlement trx in this phase does NOT insert the `transactions(commission)` row or update `restaurant_balances`. Phase 3's settlement only flips COD `transactions(cod_collection)` to `succeeded` and inserts the `agent_earnings` row.

### Migrations

- **Edit in place: `20260507000020_create_orders.ts`** — add `assignment_attempts INT NOT NULL DEFAULT 0` and `last_assignment_at TIMESTAMP(3) NULL`. Existing data is droppable.
- `…_create_agent_presence.ts` — PostGIS extension + single-row-per-agent + partial GIST + partial btree on `last_seen_at`.
- `…_create_agent_earnings.ts` — keyed by `order_id` (UNIQUE), composite FK `(order_id, order_created_at) → orders(id, created_at)`.
- `…_create_restaurant_balances.ts` — schema lands now per `database-design.md §3.6`; **no balance writes happen until Phase 5.** The table exists so the finance phase has nothing to migrate.

### Redis keys

| Key | Type | Purpose | Updated by |
| --- | --- | --- | --- |
| `presence:geo:<region>` | GEO zset | online agents' coordinates | online/offline/ping |
| `presence:meta:<region>:<agentId>` | hash | `last_seen_at`, `active_orders`, `is_online` | online/offline/ping + assign/release |
| `presence:busy:<region>` | set | mirror of `active_orders > 0` for fast filtering | assign/release |
| `assign:reject:<orderId>` | set + TTL=10m | agents who rejected/timed-out for this attempt loop | assignment loop |

Stale-presence cleanup happens lazily inside the request path (assignment scan ZREMs/SREMs anyone past `PRESENCE_STALE_SEC`). No background worker until Phase 7.

### Code

1. Migrations above (each in every region).
2. Entities: `AgentPresenceEntity`, `AgentEarningEntity`. **No `DeliveryEntity`** — delivery state lives on `OrderEntity`.
3. Request DTOs:
   - `PresenceOnlineRequestDTO { lat: number; lng: number }` (also used for `ping`).
   - `AssignAgentRequestDTO { agentId: number }` (admin manual assign).
   - `UpdateDeliveryStatusRequestDTO { status: 'accept'|'pickup'|'deliver'|'reject' }` (agent).
4. Response DTOs: `AgentEarningsResponseDTO`, `DeliveryTaskResponseDTO`, `AssignmentResponseDTO` (returns the order with `delivery_agent_id` + `assigned_at`).
5. Repositories (`@Injectable()`):
   - `agent-presence.repository.ts` — UPSERT, `findOnlineNearestPostgres(region, lat, lng, k, staleSec)` (PostGIS GIST fallback when Redis is empty), `claimForUpdate(agentId, trx)`.
   - `agent-earning.repository.ts` — `bulkInsert` (idempotent on `order_id`), `findByAgent(agentId, range, params)`, `sumByAgent(agentId, range)`.
6. `presence.service.ts` — UPSERT Postgres + write-through Redis (`GEOADD`, `HMSET`, `SADD`/`SREM`).
7. `earning.service.ts` — list + sum, cursor pagination, archive routing in Phase 7.
8. `agent.service.ts` — `listTasks(agentId, status?, params)` backed by `OrderRepository.findByAgent(...)` (status filter `assigned|accepted|picked|delivered`).
9. **`assignment.service.ts` (lives inside `OrderModule`)** — implements the Smart Assignment Loop:
   1. Resolve branch coords via `BranchClient.getBranch(branchId)` (cache hit).
   2. `ZRANGEBYSCORE`-style `GEOSEARCH presence:geo:<region> FROMLONLAT … BYRADIUS <ASSIGNMENT_RADIUS_METERS> m ASC COUNT <ASSIGNMENT_CANDIDATE_K>`.
   3. Pipeline `HMGET presence:meta:<region>:<agentId> last_seen_at active_orders` for the K candidates.
   4. Drop: stale (`now - last_seen_at > PRESENCE_STALE_SEC`, default 300s), already on the order's `assign:reject:<orderId>` set, or offline. Lazily `ZREM`/`SREM` the stale ones.
   5. **Sort in JS by `(active_orders ASC, distance ASC)`**.
   6. For `array[0]`:
      - `trx.transaction()`. `SELECT ... FROM agent_presence WHERE agent_id = ? FOR UPDATE`. Verify `is_online=TRUE`, `last_seen > NOW() - PRESENCE_STALE_SEC`.
      - `UPDATE orders SET status='assigned', delivery_agent_id=?, assigned_at=NOW(), assignment_attempts = assignment_attempts + 1, last_assignment_at = NOW() WHERE id=? AND status='ready' RETURNING *`. If the WHERE clause matches 0 rows the order moved (raced) → rollback + abort.
      - `HINCRBY presence:meta:<region>:<agent> active_orders 1`; `SADD presence:busy:<region> <agent>`.
      - Commit.
      - WS: `wsPublisher.emit('agent:<id>', 'task.assigned', taskDto)`.
      - Wait for the agent's PATCH within `AGENT_ACCEPT_TIMEOUT_SEC` (in-process timer; the agent calls `PATCH /orders/:publicId/delivery-status {accept}`).
   7. On reject/timeout: `SADD assign:reject:<orderId> <agentId>` (TTL 600s), `HINCRBY active_orders -1`, `SREM presence:busy` if zero, `UPDATE orders SET status='ready', delivery_agent_id=NULL` in trx, retry `array[1]`.
   8. After exhausting candidates **and** `assignment_attempts >= MAX_REASSIGNMENT_ATTEMPTS`: emit `wsPublisher.emit('admin:<region>:alerts', 'assignment.unassigned', {orderId})`, leave order at `ready`.
10. **Cross-module hook**: `OrderService.updateStatus` for target `READY` (after commit) calls `AssignmentService.tryAssign(orderId)` in-process. Failures are logged and do NOT roll back the kitchen's status flip.
11. Settlement on `delivered` (in the same trx as the status flip):
    - `UPDATE orders SET status='delivered', delivered_at=NOW()`.
    - For COD: `UPDATE transactions SET status='succeeded' WHERE order_id=? AND transaction_type='cod_collection' AND status='pending'`. (Online is already `charge` + `succeeded` from the webhook.)
    - `INSERT INTO agent_earnings (region, agent_id, order_id, order_created_at, amount, currency)` — UNIQUE on `order_id` makes it idempotent. Amount = `floor(branch.deliveryFee × AGENT_SHARE_RATE)` (env, default 1.0 today; revisit when commission lands in Phase 5).
    - `// Phase 5 (finance):` insert `transactions(commission)`, `UPDATE restaurant_balances.balance += subtotal - commission`. Marked with that comment in code.
    - Outside the trx: `HINCRBY presence:meta active_orders -1`, `SREM presence:busy` if zero, `DEL assign:reject:<orderId>`.
12. Endpoints (no `/deliveries/*` — delivery actions live on the order):
    - `POST /orders/:publicId/assign` — admin manual; `{ agentId }`. Skips the candidate loop, runs the trx block from step 9.
    - `POST /orders/:publicId/reassign` — admin; flips current attempt to a virtual reject (`assign:reject` add) and re-runs the loop.
    - `PATCH /orders/:publicId/delivery-status` — agent only; `{ status }`. Transitions handled by `OrderStatusService` (extended with the agent rules table from `business-logic/deliveries.md §4`). On `deliver`: settlement trx. On `reject`: triggers reassignment.
    - `POST /agents/presence/{online|offline|ping}`, `GET /agents/tasks?status=`, `GET /agents/earnings?from=&to=` (per `business-logic/agents.md`).
13. Apply guards:
    - Agent endpoints: `@UseGuards(JwtAuthGuard)` + service-side assertion `req.user.role === 'delivery_agent'`.
    - Admin assign/reassign: `@UseGuards(JwtAuthGuard, PermissionsGuard) @RequirePermissions('deliveries', 'assign')`.

### Concurrency notes

- The `SELECT agent_presence FOR UPDATE` + `UPDATE orders ... WHERE status='ready'` in one trx handles two concurrent `tryAssign` calls picking the same `array[0]` agent — the loser sees 0-row update and falls through to `array[1]`.
- The `assign:reject` Redis set carries a TTL longer than the assignment loop budget so a long-tailed retry can't reuse a just-rejected agent.
- A lightweight Lua-script atomic claim is intentionally **not** used for v1; it's the documented next step if contention shows up.

### Core-service changes required

- `GET /api/internal/agents/:id` — returns `{ id, name, phone }` for the customer-facing assignment payload. API-key guard.
- Confirm `delivery_agent` is a `system_role` (already seeded in core).
- Confirm the `deliveries:assign` permission seeded in Phase 0 maps to `system_admin` only.

### Acceptance

- An order moved to `ready` triggers `AssignmentService.tryAssign(orderId)` after commit; with one online agent in radius, the order ends up `assigned` with `delivery_agent_id` set and `assignment_attempts=1`.
- WS `task.assigned` lands on `agent:<id>`.
- Agent `PATCH /orders/:publicId/delivery-status {accept}` flips status to `accepted`. `pickup` → `picked`. `deliver` → `delivered` and inserts `agent_earnings(order_id=…)`. Re-running the same `deliver` call is a no-op for earnings (UNIQUE on `order_id`).
- For COD: the prior `transactions(type='cod_collection', status='pending')` row flips to `succeeded` in the same trx as `delivered`.
- For online: no new transaction is created on `delivered` (charge already exists).
- `restaurant_balances.balance` is **not** modified in this phase. `transactions(type='commission')` is **not** inserted. Both deferred to Phase 5.
- `POST /agents/presence/online` UPSERTs Postgres and registers the agent in `presence:geo:<region>` + `presence:meta:<region>:<agentId>`.
- Agent reject / accept-timeout: order returns to `ready`, `delivery_agent_id` cleared, agent added to `assign:reject:<orderId>`, loop picks the next candidate, `assignment_attempts` increments per attempt.
- Three full attempts with no acceptance → `assignment.unassigned` WS to admin channel; order stays `ready`.
- Postgres GIST fallback: with Redis flushed, the assignment scan still finds candidates via `agent_presence` and the partial GIST index `idx_agent_presence_location_gist`.
- Going offline while in `picked` → 409 `Cannot go offline with active pickup`. Going offline while `assigned/accepted` → triggers reassignment.
- `GET /agents/tasks?status=assigned` returns the agent's open tasks; cursor pagination works. Backed by `idx_orders_delivery_agent_id_status`.
- `GET /agents/earnings?from=&to=` returns `agent_earnings` rows + sum, paginated.

---

## Phase 4 — Restaurant Finance module

> Renumbered from the original Phase 5 because Deliveries+Agents merged into Phase 3. This phase wires up the commission + balance writes that Phase 3 deferred.

No new migrations (`restaurant_balances` already created in Phase 3).

### Code

1. Entities: `RestaurantBalanceEntity`, reuse `TransactionEntity`.
2. DTOs: `RestaurantBalanceResponseDTO`, `PayoutResponseDTO`, `CreatePayoutRequestDTO`.
3. Repositories: `restaurant-balance.repository.ts` (`upsertForUpdate`, `incrementBalance`); extend `transaction.repository.ts` with `findPayouts(restaurantId, from, to, paginationParams)`.
4. `restaurant-finance.service.ts` — `getBalance`, `listPayouts`, `recordPayout` (admin).
5. **Wire commission into the delivered settlement trx** (in `OrderService.markDelivered` or `AssignmentService.settle`):
   - Compute `commission = floor(subtotal × branch.commissionRate)`. Update `orders.commission`.
   - `INSERT transactions (type='commission', method='system', status='succeeded', amount=commission, src=ownerId, dst=NULL)`.
   - `UPDATE restaurant_balances SET balance = balance + (subtotal - commission)` with `FOR UPDATE` row lock.
   - All inside the same trx as the existing Phase 3 settlement (COD flip + agent_earnings insert).
6. Controller + `restaurant-finance.module.ts` for `/restaurant/balance`, `/restaurant/payouts`; add to `app.module.ts`.
7. `@UseInterceptors(IdempotencyInterceptor) @Idempotency({ strict: true })` on `POST /restaurant/payouts`.

### Core-service changes required

- `finance:read` permission already seeded (from Phase 0 core seed). Mapped to `owner` and `branch_manager`.

### Acceptance

- A new `delivered` order now also writes a `transactions(commission)` row and increments `restaurant_balances.balance` by `subtotal - commission` in the same trx as the agent earning.
- Owner and manager can read balance + payouts; staff cannot.
- Admin can record a payout; balance decrements; same idempotency key returns the same payout.
- Payout > balance → 409 `InsufficientBalance`.

---

## Phase 5 — WebSocket event wiring

The WS server, hub, auth, and publisher already exist from Phase 0. This phase wires **events** from existing services into that publisher.

Services inject `WsPublisher` (exported by `WsModule`) and call `wsPublisher.emit(channel, event, payload)` after the trx commits.

1. **In `OrderService`**:
   - `placeOrder` → `branch:<id>:order.created` (COD) after commit; for online this is deferred until `payment.captured` in the webhook service.
   - `updateStatus` → `customer:<id>` and `branch:<id>` `order.status_changed`.
2. **In `PaymentService` / `KashierWebhookService`**:
   - On `captured`: `customer:<id>:order.status_changed` (to `placed`) and `branch:<id>:order.created`.
   - On `failed`: `customer:<id>:payment.failed`.
3. **In `AssignmentService` / `OrderService` (delivery actions)**:
   - `tryAssign` (after commit) → `agent:<id>:task.assigned`; on exhaustion → `admin:<region>:alerts:assignment.unassigned`.
   - `PATCH /orders/:publicId/delivery-status` → `customer:<id>` and `branch:<id>` `delivery.status_changed`.
4. **In `PresenceService`**:
   - During `ping`, if the agent has an active delivery, publish `customer:<id>:delivery.position`.
5. **Channel-permission guards**:
   - Harden `ws-auth.ts` permitted-channel computation against new channels (admin alert channel).

### Core-service changes required

- None — WS is end-user facing, not inter-service.

### Acceptance

- A customer client connects, subscribes to `customer:<id>`, places a COD order, and receives `order.created` without polling.
- A branch client receives `order.created` events for its branch only.
- An unauthorized channel subscription closes the socket with the documented code.

---

## Phase 6 — Background Workers (Archival & Assignment Sweeper)

### 6.1 Assignment Timeout Sweeper Worker

**Goal:** Ensure orders do not get stuck in the `ASSIGNED` state if an agent's phone turns off or they lose connection and fail to accept/pick up the order.

1. `lib/jobs/assignment-sweeper.worker.ts` — `@Injectable()` worker scheduled every 1-2 minutes via `@Cron`.
2. Logic:
   - Finds all orders currently in `ASSIGNED` status across all regions.
   - For each order, retrieves the assigned agent's `last_seen_at` from Redis (via `PresenceService`).
   - If the agent is offline or `last_seen_at` is older than 5 minutes (stale), it automatically calls `AssignmentService.reassign(region, orderId, orderCreatedAt)`.
   - Leaves a log indicating that the order was automatically reassigned due to agent staleness.
3. Registered in `lib/jobs/jobs.module.ts`.

### 6.2 Cold archival worker

### Goal

Every night, move rows whose `created_at` is in a **prior year** from the hot cluster to the archive cluster per region. Keep the hot DB small enough that current-year queries stay fast.

### Migrations

- None in the hot cluster. The archive cluster runs the same migration set as the hot cluster (hot cluster schema == archive cluster schema). Run `npm run migrate:all --cluster=archive` once per region.

### Code

1. `lib/jobs/jobs.module.ts` + `archival.worker.ts` — one `@Injectable()` worker scheduled nightly via `@nestjs/schedule`'s `@Cron(...)`. Guards each run with a Redis lock `archival:<region>:lock` to avoid duplicate runs if multiple processes start. Iterates the configured region list inside the cron handler:
   - Walk tables in FK-safe order: `agent_earnings → payment_webhook_events → payment_sessions → transactions → order_items → orders`. (No `deliveries` table — see Phase 3.)
   - For each table, loop in batches of 1000 rows where `created_at < date_trunc('year', NOW())`:
     - Begin trx on hot + trx on archive.
     - `SELECT ... FROM hot WHERE id IN (...)` / `INSERT ... INTO archive` / `DELETE FROM hot WHERE id IN (...)`.
     - Commit archive first, then hot (so a crash mid-move leaves the row in both places, which is safer than in neither; a re-run then re-inserts with `ON CONFLICT DO NOTHING`).
   - Respect a max runtime per night (env `ARCHIVAL_MAX_RUNTIME_MIN`, default 60).
   - Emit structured log lines per batch (rows moved, table, region, duration).
2. **Read-path routing** updates:
   - `GET /customer/orders?year=YYYY` and `GET /restaurant/orders?from&to`: if the requested range is entirely in prior years → route reads to `this.knex.dbArchive(region)` instead of `this.knex.db(region)`. If the range straddles the boundary → split the query in the service, merge results in the DTO layer (rare path; document the fan-out).
   - `GET /orders/{publicId}`: try hot first; if not found and the request is for an admin or owner, retry on archive. Keep this path off the critical customer-order-tracking flow.
3. Archive-cluster knex connections live alongside the hot ones in `lib/sharding/shards.ts`; the `KNEX_CONNECTION` provider already exposes `dbArchive(region)` (slot reserved since Phase 0).

### Core-service changes required

- None.

### Acceptance

- Seed 5,000 orders in the hot cluster, half of them dated prior year.
- Run the archival worker once.
- Hot cluster has only current-year rows; archive cluster has the prior-year rows.
- `GET /customer/orders?year=<priorYear>` returns rows from the archive cluster; `EXPLAIN` shows it's hitting the archive.
- Re-running the worker is a no-op (nothing left to move; logs say `moved=0`).
- Killing the worker mid-batch and restarting it does not duplicate rows (archive inserts use `ON CONFLICT DO NOTHING`).

---

## Build cadence summary

```
Phase 0  Scaffolding (WS base, core-client base, inbound core RabbitMQ consumer)
Phase 1  Orders                                ───►  COD orders end-to-end
Phase 2  Payments + Kashier                    ───►  online orders end-to-end
Phase 3  Deliveries + Agents (compressed)      ───►  auto-assignment + agent earnings on delivered
                                                    (commission + balance deferred to Phase 4)
Phase 4  Restaurant finance                    ───►  full money flow + owner/admin financial views
Phase 5  WebSocket event wiring                ───►  real-time everywhere
Phase 6  Background workers                    ───►  hot DB stays small & stuck orders are auto-reassigned
```

Each phase is shippable. No phase mixes modules. No phase is started until the previous phase's acceptance is checked AND the matching **"Core-service changes required"** for that phase (listed inline above) are in place.
