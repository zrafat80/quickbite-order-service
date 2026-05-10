import assert from "node:assert";
import http from "node:http";
import {CoreClient} from "../src/lib/core-client/core-client";

interface CapturedRequest {
    method?: string;
    url?: string;
    auth?: string;
    correlation?: string;
    idempotency?: string;
}

function startMockServer(mode: "ok" | "flaky" | "bad-key"): Promise<{
    close(): Promise<void>;
    port: number;
    captured: CapturedRequest[];
}> {
    return new Promise((resolve) => {
        const captured: CapturedRequest[] = [];
        let attempt = 0;

        const server = http.createServer((req, res) => {
            captured.push({
                method: req.method,
                url: req.url,
                auth: req.headers["authorization"] as string | undefined,
                correlation: req.headers["x-correlationid"] as string | undefined,
                idempotency: req.headers["idempotency-key"] as string | undefined,
            });

            const expectedAuth = "ApiKey test-api-key";

            if (mode === "bad-key" && req.headers["authorization"] !== expectedAuth) {
                res.writeHead(401).end();
                return;
            }

            attempt++;
            if (mode === "flaky" && attempt < 3) {
                res.writeHead(503).end("upstream");
                return;
            }

            res.writeHead(200, {"Content-Type": "application/json"});
            res.end(JSON.stringify({ok: true, attempt}));
        });

        server.listen(0, () => {
            const addr = server.address();
            if (typeof addr === "string" || !addr) throw new Error("no port");
            resolve({
                port: addr.port,
                captured,
                close: () =>
                    new Promise<void>((r) => server.close(() => r())),
            });
        });
    });
}

async function main() {
    // 1. happy path: API key + correlationId forwarded, 200 returned
    {
        const mock = await startMockServer("ok");
        const client = new CoreClient(`http://localhost:${mock.port}`, "test-api-key");
        const body = await client.request<{ok: boolean}>({
            method: "GET",
            path: "/api/internal/branches/42",
            correlationId: "corr-abc",
            idempotencyKey: "idem-xyz",
        });
        assert.strictEqual(body.ok, true);
        assert.strictEqual(mock.captured[0].auth, "ApiKey test-api-key");
        assert.strictEqual(mock.captured[0].correlation, "corr-abc");
        assert.strictEqual(mock.captured[0].idempotency, "idem-xyz");
        await mock.close();
        console.log("✅ core-client happy path OK");
    }

    // 2. retries on 5xx: 2 failures then success, total 3 calls
    {
        const mock = await startMockServer("flaky");
        const client = new CoreClient(`http://localhost:${mock.port}`, "test-api-key");
        const body = await client.request<{attempt: number}>({
            method: "GET",
            path: "/api/internal/ping",
        });
        assert.strictEqual(body.attempt, 3, "should succeed on attempt 3");
        assert.strictEqual(mock.captured.length, 3, "should have made 3 attempts");
        await mock.close();
        console.log("✅ core-client retry OK");
    }

    // 3. 4xx is not retried, throws AppError
    {
        const mock = await startMockServer("bad-key");
        const client = new CoreClient(`http://localhost:${mock.port}`, "wrong-key");
        let threw = false;
        try {
            await client.request<unknown>({method: "GET", path: "/anything"});
        } catch (err) {
            threw = true;
            assert.match((err as Error).message, /401/);
        }
        assert.ok(threw, "should have thrown on 401");
        assert.strictEqual(mock.captured.length, 1, "should not retry 4xx");
        await mock.close();
        console.log("✅ core-client no-retry-on-4xx OK");
    }
}

main().then(
    () => process.exit(0),
    (err) => {
        console.error("❌ core-client FAILED:", err);
        process.exit(1);
    },
);
