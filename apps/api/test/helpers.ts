import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.factory";

/**
 * Boots the real app (same middleware as production) on an in-memory Postgres.
 * `env` overrides config for this instance only (config is read when the app is created).
 */
export async function createTestApp(
  env: Record<string, string> = {},
): Promise<NestExpressApplication> {
  process.env.DATABASE_URL = "pglite://memory";
  process.env.NODE_ENV = "test";
  process.env.SIGNUPS_PER_IP_PER_HOUR = "10000";
  Object.assign(process.env, env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
  await app.init();
  return app;
}

let counter = 0;
export function uniqueEmail(prefix = "user"): string {
  counter += 1;
  return `${prefix}${counter}-${Date.now()}@example.com`;
}

export const PASSWORD = "correct horse battery staple";

/** A supertest agent keeps cookies between calls, like a browser. Adds the CSRF header. */
export function browser(app: NestExpressApplication) {
  const agent = request.agent(app.getHttpServer());
  const csrf = { "x-openline-csrf": "1" };
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) =>
      agent
        .post(url)
        .set(csrf)
        .send(body ?? {}),
    patch: (url: string, body?: object) =>
      agent
        .patch(url)
        .set(csrf)
        .send(body ?? {}),
    delete: (url: string) => agent.delete(url).set(csrf),
  };
}

export type Browser = ReturnType<typeof browser>;

/** Signs up a new user + workspace and returns a logged-in browser. */
export async function signedUp(
  app: NestExpressApplication,
  overrides: { email?: string; workspaceName?: string; name?: string } = {},
): Promise<{ b: Browser; email: string }> {
  const b = browser(app);
  const email = overrides.email ?? uniqueEmail();
  const res = await b.post("/v1/auth/signup", {
    name: overrides.name ?? "Test User",
    email,
    password: PASSWORD,
    workspaceName: overrides.workspaceName ?? "Acme Sales",
  });
  if (res.status !== 201)
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { b, email };
}

/** Invites a new person with `role` into the owner's workspace and returns their browser. */
export async function joinAs(
  app: NestExpressApplication,
  owner: Browser,
  role: "admin" | "manager" | "rep",
): Promise<Browser> {
  const res = await owner.post("/v1/invites", { email: uniqueEmail(role), role });
  if (res.status !== 201)
    throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = (res.body.inviteUrl as string).split("/invite/")[1]!;
  const b = browser(app);
  const accepted = await b.post("/v1/invites/accept", {
    token,
    name: "Teammate",
    password: PASSWORD,
  });
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status}`);
  return b;
}
