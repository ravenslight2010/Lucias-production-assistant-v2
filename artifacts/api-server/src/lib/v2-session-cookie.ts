export const V2_SESSION_COOKIE_NAME = "v2_session";
const V2_SESSION_COOKIE_PATH = "/api";
const LEGACY_V2_SESSION_COOKIE_PATH = "/api/v2";

export function buildV2SessionCookieOptions(maxAgeSeconds: number, secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: V2_SESSION_COOKIE_PATH,
    maxAge: maxAgeSeconds * 1000,
  };
}

export function buildV2SessionClearCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: V2_SESSION_COOKIE_PATH,
  };
}

export function buildLegacyV2SessionClearCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: LEGACY_V2_SESSION_COOKIE_PATH,
  };
}
