import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each suite creates a fresh database and runs every migration first; CI runners are slower.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // On real Postgres (TEST_DATABASE_URL) every suite migrates the same server, and migrations
    // create cluster-wide roles: run the files one at a time so they don't race.
    fileParallelism: false,
  },
});
