import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import type { z } from "zod";

/** Every error leaves the API as { code, message, details? } (see ApiErrorSchema). */
export class ApiException extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: unknown) {
    super({ code, message, ...(details === undefined ? {} : { details }) }, status);
  }
}

export const notFound = (what = "Resource") =>
  new NotFoundException({ code: "not_found", message: `${what} not found` });

export const forbidden = (message = "You don't have permission to do that") =>
  new ForbiddenException({ code: "forbidden", message });

/** Validates input with a shared Zod schema; throws a 400 with field errors. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException({
      code: "validation_error",
      message: "Some fields are invalid",
      details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}
