import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Locally a system Chrome can stand in for the downloaded browser (CI uses chromium).
        launchOptions: process.env.CHROME_PATH
          ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] }
          : {},
      },
    },
  ],
  // Unless a deployed URL is given, start the built API (in-memory Postgres) and web app.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: "node ../../apps/api/dist/main.js",
          url: "http://localhost:4000/health",
          env: {
            DATABASE_URL: "pglite://memory",
            API_PORT: "4000",
            NODE_ENV: "test",
            SIGNUPS_PER_IP_PER_HOUR: "1000",
          },
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: "pnpm --filter @openline/web start",
          url: baseURL,
          env: { API_URL: "http://localhost:4000" },
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
