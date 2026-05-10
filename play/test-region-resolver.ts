import assert from "node:assert";
import type {NextFunction, Request, Response} from "express";
import {resolveRegion, requireRegion} from "../src/lib/sharding/region-resolver";

function fakeReq(init: Partial<Request>): Request {
    return {
        query: {},
        params: {},
        headers: {},
        ...init,
    } as Request;
}

function runMiddleware(mw: (r: Request, s: Response, n: NextFunction) => void, req: Request): {region?: string; err?: Error} {
    let captured: Error | undefined;
    try {
        mw(
            req,
            {} as Response,
            ((err?: Error) => {
                if (err) captured = err;
            }) as NextFunction,
        );
    } catch (err) {
        captured = err as Error;
    }
    return {region: req.region, err: captured};
}

function run() {
    // 1. query beats everything else
    let req = fakeReq({
        query: {region: "eg"},
        user: {userId: 1, role: "customer", email: "a@b.c", region: "sa"},
        headers: {"x-region": "gb"},
    });
    let out = runMiddleware(resolveRegion, req);
    assert.strictEqual(out.region, "eg", "query should win");

    // 2. jwt beats header
    req = fakeReq({
        user: {userId: 1, role: "customer", email: "a@b.c", region: "sa"},
        headers: {"x-region": "eg"},
    });
    out = runMiddleware(resolveRegion, req);
    assert.strictEqual(out.region, "sa", "jwt should beat header");

    // 3. header when nothing else
    req = fakeReq({headers: {"x-region": "eg"}});
    out = runMiddleware(resolveRegion, req);
    assert.strictEqual(out.region, "eg", "header fallback");

    // 4. unknown region is ignored
    req = fakeReq({query: {region: "zz"}});
    out = runMiddleware(resolveRegion, req);
    assert.strictEqual(out.region, undefined, "unknown region should not be set");

    // 5. requireRegion throws 400 when unset
    req = fakeReq({});
    out = runMiddleware(requireRegion, req);
    assert.ok(out.err, "requireRegion should throw when region is missing");
    assert.match(out.err!.message, /Region not resolved/);

    // 6. requireRegion passes when set
    req = fakeReq({});
    req.region = "eg";
    out = runMiddleware(requireRegion, req);
    assert.ok(!out.err, "requireRegion should pass when region is set");

    console.log("✅ region resolver OK");
}

try {
    run();
    process.exit(0);
} catch (err) {
    console.error("❌ region resolver FAILED:", err);
    process.exit(1);
}
