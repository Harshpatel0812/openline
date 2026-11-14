import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseHandle } from "./client";

/** Folder with the ordered SQL migrations (resolves the same from src/ and dist/). */
export const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/**
 * Applies every migrations/NNNN_*.sql file not yet recorded, in order, each in its own
 * transaction. Safe to call on every boot. Returns the files it applied.
 */
export async function migrate(handle: DatabaseHandle, dir = MIGRATIONS_DIR): Promise<string[]> {
  const applied = new Set(await handle.appliedMigrations());
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    await handle.applyMigration(file, readFileSync(join(dir, file), "utf8"));
    ran.push(file);
  }
  return ran;
}
