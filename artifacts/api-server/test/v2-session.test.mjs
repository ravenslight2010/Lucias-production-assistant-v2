import assert from "node:assert/strict";
import test from "node:test";
import {
  buildV2SessionClearCookieOptions,
  buildV2SessionCookieOptions,
  V2_SESSION_COOKIE_NAME,
} from "../src/lib/v2-session-cookie.ts";

test("V2 session cookie covers every API route", () => {
  const options = buildV2SessionCookieOptions(3600, false);
  assert.equal(V2_SESSION_COOKIE_NAME, "v2_session");
  assert.equal(options.path, "/api");
  assert.equal(options.httpOnly, true);
  assert.equal(options.maxAge, 3_600_000);
});

test("V2 session clearing uses the same API-wide cookie path", () => {
  const options = buildV2SessionClearCookieOptions(false);
  assert.equal(options.path, "/api");
  assert.equal(options.httpOnly, true);
});
