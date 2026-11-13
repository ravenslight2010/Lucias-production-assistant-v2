import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cookieParser from "cookie-parser";
import { createServer } from "node:http";
import { pool } from "@workspace/db";
import { HttpError } from "../src/lib/http-error";
import { createHealthRouter } from "../src/routes/health";
import productionRouter from "../src/routes/production";

const port = Number(process.env.PILOT_HTTP_PORT);
const actorId = process.env.PILOT_ACTOR_ID;
const clerkSessionId = process.env.PILOT_CLERK_SESSION_ID;

if (!Number.isInteger(port) || port < 1 || port > 65_535 || !actorId || !clerkSessionId) {
  throw new Error("Pilot test server configuration is incomplete.");
}

const app = express();
app.use(express.json(), cookieParser());
app.use((req, _res, next) => {
  const authHandler = Object.assign(
    () => ({
      userId: actorId,
      sessionId: clerkSessionId,
      tokenType: "session_token" as const,
    }),
    { [Symbol.for("@clerk/express.auth")]: true },
  );
  (req as Request & { auth: typeof authHandler }).auth = authHandler;
  req.log = {
    debug() {},
    error() {},
    info() {},
    warn() {},
  };
  next();
});
app.use(createHealthRouter({ getWorkerAvailability: () => "available" }));
app.use(productionRouter);
app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: "Request could not be completed." });
  },
);

const server = createServer(app);
server.listen(port, "127.0.0.1");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
}

process.once("SIGTERM", () => {
  void stop().then(() => process.exit(0), () => process.exit(1));
});
process.once("SIGINT", () => {
  void stop().then(() => process.exit(0), () => process.exit(1));
});
