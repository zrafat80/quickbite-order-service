import assert from "node:assert";
import net from "node:net";
import {randomUUID} from "node:crypto";
import {env} from "../src/lib/config/env";
import {messageBroker} from "../src/lib/messaging/init";
import {cacheProvider} from "../src/lib/cache/init";
import {destroyAll} from "../src/lib/knex/knex";

/**
 * End-to-end: publishes a `product.stock.changed` envelope and asserts the
 * consumer marked it processed (dedupe key present).
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

    await messageBroker.connect();
    await messageBroker.declareTopology({
        exchange: env.rabbit.exchange,
        queue: env.rabbit.queue,
        bindingKeys: env.rabbit.bindings,
        deadLetterExchange: env.rabbit.dlx,
        deadLetterQueue: env.rabbit.dlq,
        prefetch: env.rabbit.prefetch,
    });

    const eventId = randomUUID();
    const eventType = "product.stock.changed";
    const payload = {branchId: 123, productId: 456, newStock: 5, isAvailable: true};
    const envelope = {eventId, eventType, occurredAt: new Date().toISOString(), payload};

    console.log("publishing →", {eventType});
    await messageBroker.publish(env.rabbit.exchange, eventType, Buffer.from(JSON.stringify(envelope), "utf8"));

    const dedupeKey = `core-events:dedupe:${eventId}`;
    let seen: string | null = null;
    for (let i = 0; i < 50; i++) {
        seen = await cacheProvider.get(dedupeKey);
        if (seen) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(seen, "consumer did not record dedupe key within 5s");
    console.log("✅ product.stock.changed consumed end-to-end");

    await cacheProvider.del(dedupeKey);
    await messageBroker.close();
    await destroyAll();
}

main().then(
    () => process.exit(0),
    async (err) => {
        console.error("❌ FAILED:", err);
        try {
            await messageBroker.close();
        } catch {}
        try {
            await destroyAll();
        } catch {}
        process.exit(1);
    },
);
