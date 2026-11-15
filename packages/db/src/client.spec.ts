import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase } from "./client";

describe("createDatabase (on-disk PGlite for local development)", () => {
  const root = mkdtempSync(join(tmpdir(), "openline-db-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("creates missing parent folders, as on a fresh clone (`.data/dev`)", async () => {
    const location = join(root, ".data", "dev");
    expect(existsSync(join(root, ".data"))).toBe(false);

    const handle = await createDatabase(`pglite://${location}`);
    try {
      expect(existsSync(location)).toBe(true);
    } finally {
      await handle.close();
    }
  }, 60_000); // a fresh on-disk database runs every migration: slow on CI runners
});
