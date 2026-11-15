import type { z } from "zod";

/**
 * Pulls the JSON object out of a model answer (tolerates a ```json fence or stray prose around
 * it) and validates it. Returns null when there is no valid object — never throws.
 */
export function parseModelJson<S extends z.ZodType>(schema: S, text: string): z.output<S> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}
