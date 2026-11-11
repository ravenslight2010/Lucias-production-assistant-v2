import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAuth } from "@clerk/express";
import type { Request, RequestHandler, Response } from "express";
import { HttpError } from "./http-error";

const SESSION_COOKIE = "v2_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const TOKEN_VERSION = 1;

interface V2SessionPayload {
  version: number;
  actorId: string;
  clerkSessionId: string;
  csrfToken: string;
  expiresAt: number;
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes.");
  }
  return secret;
}

function signature(payload: string) {
  return createHmac("sha256", sessionSecret()).update(payload).digest();
}

function sign(payload: V2SessionPayload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signature(body).toString("base64url")}`;
}

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function issueV2Session(actorId: string, clerkSessionId: string) {
  const payload: V2SessionPayload = {
    version: TOKEN_VERSION,
    actorId,
    clerkSessionId,
    csrfToken: randomBytes(32).toString("base64url"),
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  return {
    token: sign(payload),
    csrfToken: payload.csrfToken,
    maxAgeSeconds: SESSION_TTL_SECONDS,
  };
}

function verifyV2Session(token: string | undefined): V2SessionPayload | null {
  if (!token) return null;
  const [body, suppliedSignature, extra] = token.split(".");
  if (!body || !suppliedSignature || extra) return null;
  try {
    const expected = signature(body).toString("base64url");
    if (!safeEqual(suppliedSignature, expected)) return null;
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<V2SessionPayload>;
    if (
      payload.version !== TOKEN_VERSION ||
      typeof payload.actorId !== "string" ||
      !payload.actorId ||
      typeof payload.clerkSessionId !== "string" ||
      !payload.clerkSessionId ||
      typeof payload.csrfToken !== "string" ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload as V2SessionPayload;
  } catch {
    return null;
  }
}

export function verifyV2SessionToken(
  token: string | undefined,
  clerkUserId: string | null,
  clerkSessionId: string | null,
) {
  const session = verifyV2Session(token);
  if (
    !session ||
    !clerkUserId ||
    !clerkSessionId ||
    session.actorId !== clerkUserId ||
    session.clerkSessionId !== clerkSessionId
  ) {
    return null;
  }
  return session;
}

export function setV2SessionCookie(
  res: Response,
  token: string,
  maxAgeSeconds: number,
) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/v2",
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearV2SessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/v2",
  });
}

export const requireV2Session: RequestHandler = (req, res, next) => {
  const clerkAuth = getAuth(req);
  const session = verifyV2SessionToken(
    req.cookies?.[SESSION_COOKIE],
    clerkAuth.userId,
    clerkAuth.sessionId,
  );
  if (!session) {
    res.status(401).json({ error: "A current V2 session is required." });
    return;
  }
  res.locals.v2ActorId = session.actorId;
  res.locals.v2CsrfToken = session.csrfToken;
  next();
};

export const requireV2Csrf: RequestHandler = (req, res, next) => {
  const origin = req.get("origin");
  const forwardedHost = req.get("x-forwarded-host");
  const expectedHost = (forwardedHost || req.get("host") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const token = req.get("x-csrf-token");
  const sessionToken = res.locals.v2CsrfToken;

  let originMatches = false;
  try {
    const parsed = origin ? new URL(origin) : null;
    originMatches = Boolean(
      parsed &&
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.host.toLowerCase() === expectedHost,
    );
  } catch {
    originMatches = false;
  }

  if (
    !originMatches ||
    typeof token !== "string" ||
    typeof sessionToken !== "string" ||
    !safeEqual(token, sessionToken)
  ) {
    res.status(403).json({ error: "Request origin could not be verified." });
    return;
  }
  next();
};

export function currentClerkIdentity(req: Request) {
  const auth = getAuth(req);
  if (!auth.userId || !auth.sessionId) {
    throw new HttpError(401, "Sign in to continue.");
  }
  return { actorId: auth.userId, sessionId: auth.sessionId };
}

