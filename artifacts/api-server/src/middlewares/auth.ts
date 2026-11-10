import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

export function getActorId(req: Parameters<typeof getAuth>[0]): string | null {
  return getAuth(req).userId ?? null;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!getActorId(req)) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  next();
};
