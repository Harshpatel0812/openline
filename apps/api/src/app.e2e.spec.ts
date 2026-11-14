import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "./app.module";

describe("API (integration)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("v1", { exclude: ["health"] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns ok", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /v1/compliance/send-window answers for a valid time zone", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/compliance/send-window")
      .query({ timeZone: "America/New_York" })
      .expect(200);
    expect(typeof res.body.allowedNow).toBe("boolean");
  });

  it("rejects an unknown time zone with the standard error shape", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/compliance/send-window")
      .query({ timeZone: "Mars/Olympus" })
      .expect(400);
    expect(res.body.code).toBe("invalid_time_zone");
  });
});
