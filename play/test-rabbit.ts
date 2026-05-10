import assert from "node:assert";
import net from "node:net";
import {randomUUID} from "node:crypto";
import {env} from "../src/lib/config/env";
import {messageBroker} from "../src/lib/messaging/init";
import {cacheProvider} from "../src/lib/cache/init";
import {destroyAll} from "../src/lib/knex/knex";

/**
 * Requires a running dev server (`npm run dev`) + RabbitMQ + Redis.
 *
 * Publishes a test event with an unknown type to `core.events` and asserts:
 *  - the consumer set a dedupe key in Redis
 *  - a replayed message with the same eventId is deduped (dedupe key already set)
 */

function probe(host: string, port: number, timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
        const s = net.createConnection({host, port});
        const done = (ok: boolean) => {
            s.destroy();
            resolve(ok);
        };
        s.on("connect", () => done(true));
        s.on("error", () => done(false));
        setTimeout(() => done(false), timeoutMs);
    });
}

async function main() {
    const url = new URL(env.rabbit.url);
    const host = url.hostname || "localhost";
    const port = url.port ? Number(url.port) : 5672;
    if (!(await probe(host, port))) {
        console.log(`⏭  rabbit not running at ${host}:${port} — skipping`);
        process.exit(0);
    }

    const eventId = randomUUID();
    const eventType = "product.test-sentinel";
    const payload = {branchId: 1, productId: 2, sentinel: true};

    await messageBroker.connect();
    await messageBroker.declareTopology({
        exchange: env.rabbit.exchange,
        queue: env.rabbit.queue,
        bindingKeys: env.rabbit.bindings,
        deadLetterExchange: env.rabbit.dlx,
        deadLetterQueue: env.rabbit.dlq,
        prefetch: env.rabbit.prefetch,
    });

    const envelope = {eventId, eventType, occurredAt: new Date().toISOString(), payload};
    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    const dedupeKey = `core-events:dedupe:${eventId}`;

    console.log("publishing event", {eventId, eventType});
    await messageBroker.publish(env.rabbit.exchange, eventType, body);

    // Poll Redis up to ~5s waiting for the dedupe key to appear.
    let seen: string | null = null;
    for (let i = 0; i < 50; i++) {
        seen = await cacheProvider.get(dedupeKey);
        if (seen) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(seen, "consumer did not record the dedupe key within 5s");
    console.log("✅ dedupe key written:", dedupeKey);

    // Replay the same envelope — should be a no-op (handler not re-invoked, dedupe key unchanged).
    await messageBroker.publish(env.rabbit.exchange, eventType, body);
    await new Promise((r) => setTimeout(r, 1500));
    const stillThere = await cacheProvider.get(dedupeKey);
    assert.ok(stillThere, "dedupe key should persist across replay");
    console.log("✅ replay is a no-op (dedupe intact)");

    // Cleanup
    await cacheProvider.del(dedupeKey);
    await messageBroker.close();
    await destroyAll();
}

main().then(
    () => process.exit(0),
    async (err) => {
        console.error("❌ rabbit test FAILED:", err.stack ?? err);
        try {
            await messageBroker.close();
        } catch {}
        try {
            await destroyAll();
        } catch {}
        process.exit(1);
    },
);
