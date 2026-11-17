import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The mail sink speaks STARTTLS with a throwaway certificate made here (never committed). The API
// trusts it through NODE_EXTRA_CA_CERTS, so certificate checks stay on exactly as in production.
const tlsDir = join(tmpdir(), "openline-e2e-mail");
const tlsKey = join(tlsDir, "key.pem");
const tlsCert = join(tlsDir, "cert.pem");
if (!process.env.E2E_BASE_URL && !existsSync(tlsCert)) {
  mkdirSync(tlsDir, { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "30",
      "-keyout",
      tlsKey,
      "-out",
      tlsCert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
}

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
          // Local SMTP sink: catches verification and outreach emails; relays nothing.
          command: "node support/mail-sink.mjs",
          env: { MAIL_SINK_TLS_KEY: tlsKey, MAIL_SINK_TLS_CERT: tlsCert },
          url: "http://127.0.0.1:2580/health",
          reuseExistingServer: !process.env.CI,
          timeout: 15_000,
        },
        {
          // Fake HubSpot + Pipedrive (OAuth, APIs, record pages, control plane): no real CRM.
          command: "node support/fake-crm.mjs",
          env: { FAKE_CRM_PORT: "4900" },
          url: "http://127.0.0.1:4900/health",
          reuseExistingServer: !process.env.CI,
          timeout: 15_000,
        },
        {
          command: "node ../../apps/api/dist/main.js",
          url: "http://localhost:4000/health",
          env: {
            DATABASE_URL: "pglite://memory",
            API_PORT: "4000",
            NODE_ENV: "test",
            SIGNUPS_PER_IP_PER_HOUR: "1000",
            WEB_URL: baseURL,
            // Every email (ours and outreach) goes to the sink; the engine runs in-process.
            MAIL_TRANSPORT: "smtp",
            SMTP_URL: "smtp://127.0.0.1:2525",
            OUTREACH_TRANSPORT: "sandbox",
            RUN_SCHEDULER: "true",
            NODE_EXTRA_CA_CERTS: tlsCert,
            // Scout runs on the deterministic fake model: no network, no API key.
            AI_PROVIDER: "fake",
            // CRM sync talks to the fake CRM server above only.
            CRM_MODE: "fake",
            CRM_FAKE_BASE_URL: "http://127.0.0.1:4900",
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
