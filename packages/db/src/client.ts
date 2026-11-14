import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface DatabaseHandle {
  db: Db;
  kind: "pglite" | "postgres";
  /** Names of migrations already applied. */
  appliedMigrations(): Promise<string[]>;
  /** Run one migration file and record it, atomically. */
  applyMigration(name: string, body: string): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_TABLE =
  "CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())";

/**
 * Connects from a URL:
 *  - `pglite://memory`        in-memory Postgres (tests, e2e)
 *  - `pglite://./.data/dev`   on-disk Postgres for local dev, no Docker needed
 *  - `postgres://...`         real Postgres (staging, production, CI integration)
 */
export function createDatabase(url: string): DatabaseHandle {
  if (url.startsWith("pglite://")) {
    const location = url.slice("pglite://".length);
    const client = location === "memory" || location === "" ? new PGlite() : new PGlite(location);
    const db = drizzlePglite(client, { schema }) as unknown as Db;
    return {
      db,
      kind: "pglite",
      async appliedMigrations() {
        await client.exec(MIGRATIONS_TABLE);
        const res = await client.query<{ name: string }>("SELECT name FROM _migrations");
        return res.rows.map((r) => r.name);
      },
      async applyMigration(name, body) {
        await client.transaction(async (tx) => {
          await tx.exec(body);
          await tx.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
        });
      },
      close: () => client.close(),
    };
  }

  const pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  const db = drizzlePg(pool, { schema }) as unknown as Db;
  return {
    db,
    kind: "postgres",
    async appliedMigrations() {
      await pool.query(MIGRATIONS_TABLE);
      const res = await pool.query<{ name: string }>("SELECT name FROM _migrations");
      return res.rows.map((r) => r.name);
    },
    async applyMigration(name, body) {
      const conn = await pool.connect();
      try {
        await conn.query("BEGIN");
        await conn.query(body);
        await conn.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
        await conn.query("COMMIT");
      } catch (error) {
        await conn.query("ROLLBACK");
        throw error;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
}
