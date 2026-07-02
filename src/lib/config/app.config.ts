/**
 * Typed config tree. Loaded once via `ConfigModule.forRoot({ isGlobal: true,
 * load: [appConfig] })`. Read at runtime through `ConfigService.get(...)`.
 *
 * `REGIONS` is the source of truth for which shards exist. For each region the
 * factory reads `DB_<region>_*` (hot cluster) and `ARCHIVE_DB_<region>_*` (cold)
 * env vars and builds the per-region triples. The sharded Knex provider in
 * `lib/database.providers.ts` consumes these to lazily build pools per region.
 */

export interface ShardConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  name: string;
}

function parseRegions(raw: string | undefined): string[] {
  return (raw ?? "eg")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readShardConfig(
  region: string,
  prefix: "DB" | "ARCHIVE_DB",
): ShardConfig {
  const host = process.env[`${prefix}_${region}_HOST`] || "localhost";
  const port = process.env[`${prefix}_${region}_PORT`];
  const username = process.env[`${prefix}_${region}_USERNAME`];
  const password = process.env[`${prefix}_${region}_PASSWORD`];
  const name = process.env[`${prefix}_${region}_NAME`];

  if (!host || !port || !username || !name) {
    throw new Error(
      `Missing ${prefix} env for region "${region}". Expected ${prefix}_${region}_HOST/PORT/USERNAME/PASSWORD/NAME.`,
    );
  }
  return {
    host,
    port: Number(port),
    username,
    password: password ?? "",
    name,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export default () => {
  const regions = parseRegions(process.env.REGIONS);
  const hotShards: Record<string, ShardConfig> = {};
  const archiveShards: Record<string, ShardConfig> = {};
  for (const region of regions) {
    hotShards[region] = readShardConfig(region, "DB");
    // Archive triples are read lazily — best-effort in dev. The factory only
    // throws if a service actually tries to talk to an archive shard that
    // wasn't configured, so dev environments without an archive cluster still
    // boot. Achieve that by tolerating missing archive env at boot:
    try {
      archiveShards[region] = readShardConfig(region, "ARCHIVE_DB");
    } catch {
      // Phase 7 will exercise these; until then a missing archive config is OK.
    }
  }

  return {
    environment: process.env.NODE_ENV || "development",
    port: parseInt(process.env.PORT || "4000", 10),

    cors: {
      origins: (process.env.CORS_ORIGINS || "http://localhost:3000")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },

    jwt: {
      accessSecret: process.env.ACCESS_SECRET as string,
      refreshSecret: process.env.REFRESH_SECRET as string,
      accessExpiresIn: process.env.ACCESS_EXPIRES_IN || "3600",
      refreshExpiresIn: process.env.REFRESH_EXPIRES_IN || "604800",
    },

    db: {
      poolMax: parseInt(process.env.DB_POOL_MAX || "10", 10),
      migrationDirectory:
        process.env.DB_MIGRATION_DIRECTORY || "src/database/migrations",
      migrationExtension: process.env.DB_MIGRATION_EXTENSION || "ts",
    },

    regions,
    hotShards,
    archiveShards,

    redis: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      password: process.env.REDIS_PASSWORD || undefined,
    },

    rabbit: {
      url: process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672",
      exchange: process.env.RABBITMQ_CORE_EVENTS_EXCHANGE || "core.events",
      alternateExchange:
        process.env.RABBITMQ_CORE_EVENTS_AE || "core.events.unroutable",
      alternateQueue:
        process.env.RABBITMQ_CORE_EVENTS_UNROUTABLE_QUEUE ||
        "core.events.unroutable.dlq",
      queue:
        process.env.RABBITMQ_CORE_EVENTS_QUEUE || "order-service.core-events",
      bindings: (
        process.env.RABBITMQ_CORE_EVENTS_BINDINGS ||
        "product.#,branch.#,restaurant.#,rbac.#"
      )
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      dlx: process.env.RABBITMQ_CORE_EVENTS_DLX || "core.events.dlx",
      dlq:
        process.env.RABBITMQ_CORE_EVENTS_DLQ || "order-service.core-events.dlq",
      prefetch: parseInt(process.env.RABBITMQ_PREFETCH || "32", 10),
      orderEventsExchange:
        process.env.RABBITMQ_ORDER_EVENTS_EXCHANGE || "order.events",
    },

    outbound: {
      drainTickSec: parseInt(
        process.env.OUTBOUND_EVENTS_DRAIN_TICK_SEC || "2",
        10,
      ),
      batchSize: parseInt(process.env.OUTBOUND_EVENTS_BATCH_SIZE || "100", 10),
    },

    core: {
      baseUrl: process.env.CORE_SERVICE_BASE_URL as string,
      internalApiKey: process.env.CORE_INTERNAL_API_KEY as string,
    },

    kashier: {
      // POST /v3/payment/sessions; in test mode use https://test-api.kashier.io.
      baseUrl: process.env.KASHIER_BASE_URL || "https://api.kashier.io",
      // PUT /orders/:orderId/ for refunds; in test mode use https://test-fep.kashier.io.
      fepUrl: process.env.KASHIER_FEP_URL || "https://fep.kashier.io",
      merchantId: process.env.KASHIER_MERCHANT_ID || "",
      // Payment API Key — used for `api-key` header AND order-hash AND webhook
      // signature verification (HMAC-SHA256). Distinct from secretKey below.
      apiKey: process.env.KASHIER_API_KEY || "",
      // Secret Key — used for the `Authorization` header on every API call.
      secretKey: process.env.KASHIER_SECRET_KEY || "",
      // Webhook signature secret. Default to apiKey since Kashier signs
      // webhooks with the Payment API Key, but kept overridable for rotation.
      webhookSecret:
        process.env.KASHIER_WEBHOOK_SECRET || process.env.KASHIER_API_KEY || "",
      returnUrl: process.env.KASHIER_RETURN_URL || "",
      failUrl: process.env.KASHIER_FAIL_URL || "",
      // Optional override for the webhook URL Kashier will POST back to.
      // When present we send it as `serverWebhook` on every session.
      // Useful with ngrok in dev: KASHIER_SERVER_WEBHOOK=https://xxx.ngrok.io/api/payments/webhook/kashier.
      serverWebhookUrl: process.env.KASHIER_SERVER_WEBHOOK || "",
      paymentSessionTimeoutMin: parseInt(
        process.env.PAYMENT_SESSION_TIMEOUT_MIN || "15",
        10,
      ),
    },

    deliveries: {
      assignmentRadiusMeters: parseInt(
        process.env.ASSIGNMENT_RADIUS_METERS || "5000",
        10,
      ),
      // K candidates pulled per GEOSEARCH; we sort by (active_orders, distance).
      assignmentCandidateK: parseInt(
        process.env.ASSIGNMENT_CANDIDATE_K || "5",
        10,
      ),
      agentAcceptTimeoutSec: parseInt(
        process.env.AGENT_ACCEPT_TIMEOUT_SEC || "30",
        10,
      ),
      maxReassignmentAttempts: parseInt(
        process.env.MAX_REASSIGNMENT_ATTEMPTS || "3",
        10,
      ),
      // Strict 5-minute cutoff per agreed design — agents whose last_seen_at is
      // older than this are dropped from the candidate pool and lazily evicted
      // from Redis (`presence:geo`, `presence:meta`).
      presenceStaleSec: parseInt(process.env.PRESENCE_STALE_SEC || "300", 10),
      // How long an order may sit in status='ready' without a successful
      // assignment before the sweeper re-attempts. Also doubles as the
      // spacing between retries (we bump last_assignment_at on each pass).
      readyStaleSec: parseInt(process.env.READY_STALE_SEC || "60", 10),
      assignmentSweeperEnabled: parseBoolean(
        process.env.ASSIGNMENT_SWEEPER_ENABLED,
        true,
      ),
      assignmentSweepBatchSize: parsePositiveInt(
        process.env.ASSIGNMENT_SWEEP_BATCH_SIZE,
        100,
      ),
      // Share of branch.deliveryFee paid to the agent on `delivered`.
      // Float 0..1. Default 1.0 today; tuned when commission lands in Phase 4.
      agentShareRate: parseFloat(process.env.AGENT_SHARE_RATE || "1"),
    },

    ws: {
      heartbeatSec: parseInt(process.env.WS_HEARTBEAT_SEC || "30", 10),
    },

    archival: {
      // Hard cap on a single nightly archival run. Once exceeded the worker
      // stops cleanly between batches and resumes the leftover the next night.
      maxRuntimeMin: parseInt(process.env.ARCHIVAL_MAX_RUNTIME_MIN || "60", 10),
    },
  };
};
