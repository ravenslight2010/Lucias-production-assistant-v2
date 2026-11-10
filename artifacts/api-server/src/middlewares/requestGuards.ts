import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

type WindowCounter = { count: number; expiresAt: number };
const windows = new Map<string, WindowCounter>();
const WINDOW_MS = 60_000;
const MAX_KEYS = 20_000;

function requestKey(req: Parameters<typeof getAuth>[0], category: string) {
  const actorId = getAuth(req).userId;
  const identity = actorId || req.ip || req.socket.remoteAddress || "unknown";
  return `${category}:${identity}`;
}

export const apiRateLimit: RequestHandler = (req, res, next) => {
  const now = Date.now();
  if (windows.size >= MAX_KEYS) {
    for (const [key, bucket] of windows) {
      if (bucket.expiresAt <= now) windows.delete(key);
    }
    if (windows.size >= MAX_KEYS) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Too many requests. Try again shortly." });
      return;
    }
  }

  const key = requestKey(req, "api");
  const bucket = windows.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    windows.set(key, { count: 1, expiresAt: now + WINDOW_MS });
    next();
    return;
  }
  if (bucket.count >= 180) {
    res.setHeader("Retry-After", String(Math.ceil((bucket.expiresAt - now) / 1000)));
    res.status(429).json({ error: "Too many requests. Try again shortly." });
    return;
  }
  bucket.count += 1;
  next();
};

export const mutationRateLimit: RequestHandler = (req, res, next) => {
  const now = Date.now();
  const key = requestKey(req, "write");
  const bucket = windows.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    windows.set(key, { count: 1, expiresAt: now + WINDOW_MS });
    next();
    return;
  }
  if (bucket.count >= 30) {
    res.setHeader("Retry-After", String(Math.ceil((bucket.expiresAt - now) / 1000)));
    res.status(429).json({ error: "Too many updates. Try again shortly." });
    return;
  }
  bucket.count += 1;
  next();
};

export const csrfProtection: RequestHandler = (req, res, next) => {
  const origin = req.get("origin");
  const forwardedHost = req.get("x-forwarded-host");
  const expectedHost = (forwardedHost || req.get("host") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();

  if (!origin || !expectedHost) {
    res.status(403).json({ error: "Request origin could not be verified." });
    return;
  }

  try {
    const parsedOrigin = new URL(origin);
    if (
      (parsedOrigin.protocol !== "https:" && parsedOrigin.protocol !== "http:") ||
      parsedOrigin.host.toLowerCase() !== expectedHost
    ) {
      res.status(403).json({ error: "Request origin could not be verified." });
      return;
    }
  } catch {
    res.status(403).json({ error: "Request origin could not be verified." });
    return;
  }

  next();
};
