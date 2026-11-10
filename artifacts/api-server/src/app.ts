import express, { type Express } from "express";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { apiRateLimit } from "./middlewares/requestGuards";
import { HttpError } from "./lib/http-error";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);
app.use("/api", apiRateLimit);
app.use((req, res, next) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      req.log.warn({ path: req.path }, "Request exceeded the time limit");
      res.status(504).json({ error: "Request timed out. Please try again." });
    }
  }, 15_000);
  timeout.unref();
  res.on("finish", () => clearTimeout(timeout));
  next();
});
app.use(express.json({ limit: "32kb" }));

app.use("/api", router);

app.use(
  (
    error: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (typeof error === "object" && error !== null && "status" in error) {
      const status = error.status;
      if (status === 400 || status === 413) {
        res
          .status(status)
          .json({ error: status === 413 ? "Request body is too large." : "Invalid request." });
        return;
      }
    }
    req.log.error({ err: error }, "Unhandled API error");
    res.status(500).json({ error: "Request could not be completed." });
  },
);

export default app;
