import assert from "node:assert";
import jwt from "jsonwebtoken";
import {io as ioClient} from "socket.io-client";
import "reflect-metadata";
import {env} from "../src/lib/config/env";

/**
 * Assumes the dev server is running on :4000 and Redis is reachable.
 *
 *  1. mint a JWT for a fake customer
 *  2. socket.io connect with `auth: {token}`
 *  3. server emits "hello" with allowed channels
 *  4. subscribe to the allowed customer channel — ack ok
 *  5. subscribe to a forbidden branch channel — ack error
 */

function mintCustomerJwt(userId: number): string {
    return jwt.sign(
        {userId, role: "customer", email: "test@quickbite.io"},
        env.jwt.accessSecret,
        {expiresIn: 120},
    );
}

async function main() {
    const token = mintCustomerJwt(42);
    const client = ioClient(`ws://localhost:${env.port}`, {
        path: "/ws",
        auth: {token},
        transports: ["websocket"],
        reconnection: false,
    });

    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("did not receive hello")), 3000);
        client.once("connect", () => {});
        client.once("hello", (payload) => {
            clearTimeout(t);
            try {
                assert.deepStrictEqual(payload.allowedChannels.sort(), ["customer:42"]);
                console.log("✅ hello received:", payload);
                resolve();
            } catch (err) {
                reject(err);
            }
        });
        client.once("connect_error", (err) => {
            clearTimeout(t);
            reject(err);
        });
    });

    const allowedAck: any = await new Promise((resolve) =>
        client.emit("subscribe", "customer:42", resolve),
    );
    assert.strictEqual(allowedAck.ok, true, "allowed channel must ack ok");
    console.log("✅ allowed subscribe ack:", allowedAck);

    const forbiddenAck: any = await new Promise((resolve) =>
        client.emit("subscribe", "branch:999", resolve),
    );
    assert.strictEqual(forbiddenAck.ok, false, "forbidden channel must ack not-ok");
    console.log("✅ forbidden subscribe ack:", forbiddenAck);

    client.close();
}

main().then(
    () => process.exit(0),
    (err) => {
        console.error("❌ WS test FAILED:", err.stack ?? err);
        process.exit(1);
    },
);
