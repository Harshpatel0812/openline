import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Engine suites create a fresh database and run every migration first.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
