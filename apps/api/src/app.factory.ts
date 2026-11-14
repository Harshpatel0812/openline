import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { CONFIG, type AppConfig } from "./config";
import { ErrorFilter } from "./common/error.filter";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const CSRF_HEADER = "x-openline-csrf";
const CSRF_EXEMPT = /^\/v1\/public\/unsubscribe\/[^/]+$/;

/**
 * Security and HTTP setup shared by main.ts and the integration tests, so tests exercise the
 * exact same middleware stack as production.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const config = app.get<AppConfig>(CONFIG);

  app.set("trust proxy", config.TRUST_PROXY);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cookieParser());
  // Small bodies everywhere except CSV import (up to 5 MB of CSV).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const length = Number(req.headers["content-length"] ?? 0);
    const limit = req.path.startsWith("/v1/contacts/import") ? 6_000_000 : 100_000;
    if (length > limit) {
      res.status(413).json({ code: "payload_too_large", message: "Request is too large" });
      return;
    }
    next();
  });
  app.useBodyParser("json", { limit: "6mb" });
  // Form bodies are only used by RFC 8058 one-click unsubscribe ("List-Unsubscribe=One-Click").
  // Registering it here also replaces Nest's default 100 KB urlencoded parser.
  app.useBodyParser("urlencoded", { limit: "10kb", extended: false });

  app.enableCors({
    origin: [config.WEB_URL],
    credentials: true,
    allowedHeaders: ["content-type", CSRF_HEADER],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers["x-request-id"];
    const id = typeof incoming === "string" && incoming.length <= 64 ? incoming : randomUUID();
    req.headers["x-request-id"] = id;
    res.setHeader("x-request-id", id);
    next();
  });

  // CSRF: browsers cannot add a custom header to a cross-site request without a CORS
  // preflight, and CORS only allows our web origin. Combined with SameSite=Lax cookies.
  // Exempt: the public one-click unsubscribe, posted by mail providers (no session, no cookie
  // used; the signed token in the URL is the only authority).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      !SAFE_METHODS.has(req.method) &&
      !CSRF_EXEMPT.test(req.path) &&
      req.headers[CSRF_HEADER] !== "1"
    ) {
      res.status(403).json({ code: "csrf", message: "Missing CSRF header" });
      return;
    }
    next();
  });

  app.setGlobalPrefix("v1", { exclude: ["health"] });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  return app;
}
