import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each suite creates a fresh database and runs every migration first; CI runners are slower.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
