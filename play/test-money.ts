import assert from "node:assert";
import {toMinor, fromMinor, sumMinor, multiplyMinor} from "../src/pkg/utils/money";

assert.strictEqual(toMinor(15), 1500, "15 EGP → 1500 minor");
assert.strictEqual(toMinor(15.5), 1550, "15.50 EGP → 1550 minor");
assert.strictEqual(toMinor(0.01), 1, "1 piaster");
assert.strictEqual(fromMinor(1500), 15, "1500 minor → 15 EGP");
assert.strictEqual(sumMinor([100, 200, 300]), 600, "sum");
assert.strictEqual(multiplyMinor(150, 4), 600, "unit × qty");

// Floating-point traps should not bleed into integer space.
assert.strictEqual(toMinor(0.1 + 0.2), 30, "0.1+0.2 rounded");

console.log("✅ money helpers OK");
