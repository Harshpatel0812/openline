import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC emits decorator metadata, which NestJS dependency injection needs (esbuild does not).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
