import assert from "node:assert/strict";
import test from "node:test";
import { createPoolWithValidatedMax } from "../src/pool-config.ts";

test("uses the default pool limit when DB_POOL_MAX is missing", () => {
  const createdLimits = [];
  const result = createPoolWithValidatedMax(undefined, (poolMax) => {
    createdLimits.push(poolMax);
    return { poolMax };
  });

  assert.equal(result.poolMax, 4);
  assert.deepEqual(result.pool, { poolMax: 4 });
  assert.deepEqual(createdLimits, [4]);
});

test("rejects non-integer pool limits before creating a pool", () => {
  assertInvalidPoolMax("2.5");
});

test("rejects pool limits below the minimum before creating a pool", () => {
  assertInvalidPoolMax("0");
});

test("rejects pool limits above the maximum before creating a pool", () => {
  assertInvalidPoolMax("21");
});

test("accepts the configured pool limit boundaries", () => {
  for (const expected of [1, 20]) {
    const result = createPoolWithValidatedMax(String(expected), (poolMax) => ({
      poolMax,
    }));
    assert.equal(result.poolMax, expected);
    assert.deepEqual(result.pool, { poolMax: expected });
  }
});

function assertInvalidPoolMax(rawPoolMax) {
  let poolCreated = false;

  assert.throws(
    () =>
      createPoolWithValidatedMax(rawPoolMax, () => {
        poolCreated = true;
        return {};
      }),
    {
      message: "DB_POOL_MAX must be an integer between 1 and 20.",
    },
  );
  assert.equal(
    poolCreated,
    false,
    "invalid configuration must not create a pool",
  );
}
