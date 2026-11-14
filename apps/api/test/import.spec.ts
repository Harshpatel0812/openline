import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, signedUp, type Browser } from "./helpers";

describe("contacts CSV import", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const preview = (b: Browser, csv: string) => b.post("/v1/contacts/import/preview", { csv });
  const commit = (b: Browser, csv: string, duplicates: "skip" | "update") =>
    b.post("/v1/contacts/import", { csv, duplicates, confirmLawfulBasis: true });

  it("previews a BOM, semicolon-separated Excel file without saving anything", async () => {
    const { b } = await signedUp(app);
    const csv =
      "﻿E-mail;First Name;Company;Website;Notes\r\n" +
      'jane@acme.com;Jane;"Acme; Inc.";https://www.acme.com/about;x\r\n' +
      "bob@globex.io;Bob;;;\r\n" +
      ";;;;\r\n";
    const res = await preview(b, csv).expect(200);
    expect(res.body).toMatchObject({
      totalRows: 2,
      newCount: 2,
      duplicateCount: 0,
      invalidCount: 0,
      invalid: [],
      delimiter: ";",
      mapping: {
        "E-mail": "email",
        "First Name": "firstName",
        Company: "companyName",
        Website: "companyDomain",
        Notes: null,
      },
    });
    expect(res.body.sample[0]).toMatchObject({
      email: "jane@acme.com",
      firstName: "Jane",
      companyName: "Acme; Inc.",
      companyDomain: "acme.com",
    });

    const list = await b.get("/v1/contacts").expect(200);
    expect(list.body.total).toBe(0);
  });

  it("handles quoted commas and newlines, in-file duplicates, invalid rows and existing contacts", async () => {
    const { b } = await signedUp(app);
    await b.post("/v1/contacts", { email: "existing@acme.com" }).expect(201);
    const csv = [
      "email_address,Job Title,TZ,Country",
      'Jane@acme.com,"Head of Sales, East","America/New_York",US',
      'ann@acme.com,"Line one',
      'line two",,',
      "not-an-email,CEO,,",
      "jane@ACME.com,Dup,,",
      "EXISTING@acme.com,CTO,,",
      "zed@acme.com,,Mars/Base,",
      "kim@acme.com,,,Canada",
      ",Nobody,,",
    ].join("\n");
    const res = await preview(b, csv).expect(200);
    expect(res.body).toMatchObject({
      totalRows: 8,
      newCount: 2,
      duplicateCount: 1,
      invalidCount: 5,
      delimiter: ",",
    });
    expect(res.body.mapping).toEqual({
      email_address: "email",
      "Job Title": "title",
      TZ: "timeZone",
      Country: "country",
    });
    expect(res.body.invalid).toEqual([
      { row: 3, reason: expect.stringMatching(/^Email:/) },
      { row: 4, reason: "Duplicate of row 1" },
      { row: 6, reason: expect.stringMatching(/^Time zone:/) },
      { row: 7, reason: expect.stringMatching(/^Country:/) },
      { row: 8, reason: "Missing email" },
    ]);
    expect(res.body.sample[0]).toMatchObject({
      email: "jane@acme.com",
      title: "Head of Sales, East",
      timeZone: "America/New_York",
      country: "US",
    });
    expect(res.body.sample[1].title).toBe("Line one\nline two");
  });

  it("rejects a file without an email column or with too many rows", async () => {
    const { b } = await signedUp(app);
    const noEmail = await preview(b, "name,company\nJane,Acme\n").expect(400);
    expect(noEmail.body.code).toBe("missing_email_column");

    const rows = Array.from({ length: 10_001 }, (_, i) => `p${i}@acme.com`);
    const big = await preview(b, ["email", ...rows].join("\n")).expect(400);
    expect(big.body.code).toBe("too_many_rows");
    const bigCommit = await commit(b, ["email", ...rows].join("\n"), "skip").expect(400);
    expect(bigCommit.body.code).toBe("too_many_rows");
  });

  it("requires the lawful-basis confirmation", async () => {
    const { b } = await signedUp(app);
    const res = await b
      .post("/v1/contacts/import", { csv: "email\na@acme.com", duplicates: "skip" })
      .expect(400);
    expect(res.body.code).toBe("validation_error");
    expect(res.body.details[0].path).toBe("confirmLawfulBasis");
    await b
      .post("/v1/contacts/import", {
        csv: "email\na@acme.com",
        duplicates: "skip",
        confirmLawfulBasis: false,
      })
      .expect(400);
    expect((await b.get("/v1/contacts").expect(200)).body.total).toBe(0);
  });

  it("commits with skip: creates new contacts and companies, leaves duplicates untouched", async () => {
    const { b } = await signedUp(app);
    const existing = await b
      .post("/v1/contacts", { email: "old@acme.com", firstName: "Old", title: "Keep" })
      .expect(201);
    const csv =
      "Email,First name,Title\nold@acme.com,New,Changed\nnew1@acme.com,A,\nnew2@gmail.com,B,\nbad,,\n";
    const res = await commit(b, csv, "skip").expect(200);
    expect(res.body).toEqual({ created: 2, updated: 0, skipped: 1, invalid: 1 });

    const old = await b.get(`/v1/contacts/${existing.body.id as string}`).expect(200);
    expect(old.body).toMatchObject({ firstName: "Old", title: "Keep" });

    const list = await b.get("/v1/contacts?q=new").expect(200);
    const byEmail = Object.fromEntries(
      list.body.items.map((c: { email: string }) => [c.email, c]),
    ) as Record<string, { company: { id: string } | null }>;
    expect(byEmail["new1@acme.com"]!.company!.id).toBe(existing.body.company.id);
    expect(byEmail["new2@gmail.com"]!.company).toBeNull();
  });

  it("commits with update: only non-empty cells overwrite existing fields", async () => {
    const { b } = await signedUp(app);
    const existing = await b
      .post("/v1/contacts", { email: "old@acme.com", firstName: "Old", title: "Keep", phone: "1" })
      .expect(201);
    await b.post("/v1/contacts", { email: "same@acme.com" }).expect(201);
    const csv =
      "email,first name,title,phone\nOLD@acme.com,New,,\nsame@acme.com,,,\nfresh@x.com,F,,\n";
    const res = await commit(b, csv, "update").expect(200);
    expect(res.body).toEqual({ created: 1, updated: 1, skipped: 1, invalid: 0 });

    const old = await b.get(`/v1/contacts/${existing.body.id as string}`).expect(200);
    expect(old.body).toMatchObject({
      email: "old@acme.com",
      firstName: "New",
      title: "Keep",
      phone: "1",
    });

    // Re-running the same file with skip creates nothing new.
    const again = await commit(b, csv, "skip").expect(200);
    expect(again.body).toEqual({ created: 0, updated: 0, skipped: 3, invalid: 0 });
  });

  it("imports into the caller's workspace only", async () => {
    const { b: a } = await signedUp(app);
    const { b: other } = await signedUp(app);
    await a.post("/v1/contacts", { email: "shared@acme.com" }).expect(201);
    const res = await preview(other, "email\nshared@acme.com\n").expect(200);
    expect(res.body).toMatchObject({ newCount: 1, duplicateCount: 0 });
    await commit(other, "email\nshared@acme.com\n", "skip").expect(200);
    expect((await a.get("/v1/contacts").expect(200)).body.total).toBe(1);
    expect((await other.get("/v1/contacts").expect(200)).body.total).toBe(1);
  });
});
