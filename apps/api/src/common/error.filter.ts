import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

const STATUS_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
};

/** Turns every error into { code, message, details? } and never leaks internals. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("Error");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null && "code" in body) {
        res.status(status).json(body);
        return;
      }
      const message =
        typeof body === "string" ? body : ((body as { message?: string }).message ?? "Error");
      res.status(status).json({ code: STATUS_CODES[status] ?? "error", message });
      return;
    }

    // Postgres unique violation → 409 without exposing constraint names.
    const pgCode = (exception as { code?: string; cause?: { code?: string } })?.code;
    const causeCode = (exception as { cause?: { code?: string } })?.cause?.code;
    if (pgCode === "23505" || causeCode === "23505") {
      res.status(HttpStatus.CONFLICT).json({ code: "conflict", message: "That already exists" });
      return;
    }

    // Body parser limit.
    if ((exception as { type?: string })?.type === "entity.too.large") {
      res.status(413).json({ code: "payload_too_large", message: "Request is too large" });
      return;
    }

    this.logger.error(
      `Unhandled error on ${req.method} ${req.path} [${String(req.headers["x-request-id"] ?? "-")}]`,
      safeDescribe(exception),
    );
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ code: "internal_error", message: "Something went wrong" });
  }
}

/**
 * Describes an error for logs WITHOUT personal data. Database errors carry the full query and
 * every bound parameter (emails, names, password hashes) in their message — log only codes.
 */
function safeDescribe(exception: unknown): string {
  const e = exception as {
    name?: string;
    code?: string;
    constraint?: string;
    query?: unknown;
    params?: unknown;
    cause?: { name?: string; code?: string; constraint?: string };
    stack?: string;
  };
  const db = e?.cause?.code ? e.cause : e?.code && /^[0-9A-Z]{5}$/.test(e.code) ? e : undefined;
  if (db || e?.query !== undefined || e?.params !== undefined) {
    return JSON.stringify({
      name: e?.name ?? "DatabaseError",
      code: db?.code,
      constraint: db?.constraint,
    });
  }
  const stack = typeof e?.stack === "string" ? e.stack.split("\n").slice(1, 8).join("\n") : "";
  return `${e?.name ?? "Error"}\n${stack}`;
}
