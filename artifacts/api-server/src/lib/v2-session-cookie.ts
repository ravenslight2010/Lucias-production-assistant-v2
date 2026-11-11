export const V2_SESSION_COOKIE_NAME = "v2_session";
const V2_SESSION_COOKIE_PATH = "/api";

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
