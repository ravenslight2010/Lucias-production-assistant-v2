// Small runtime-neutral assertions so the same scenario can execute in a
// Playwright notebook (without Node module imports) and a normal Node harness.
function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export default {
  ok(value, message = 'Expected a truthy value') {
    if (!value) fail(message);
  },
  equal(actual, expected, message) {
    if (!Object.is(actual, expected)) {
      fail(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  deepEqual(actual, expected, message) {
    if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
      fail(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  match(actual, pattern, message) {
    if (!pattern.test(actual)) fail(message ?? `Expected ${actual} to match ${pattern}`);
  },
};
