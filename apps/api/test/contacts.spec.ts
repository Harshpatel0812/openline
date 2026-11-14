import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, joinAs, signedUp, type Browser } from "./helpers";

describe("contacts and companies", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const create = (b: Browser, body: object) => b.post("/v1/contacts", body);

  it("creates a contact, lower-cases the email and derives the company from the domain", async () => {
    const { b } = await signedUp(app);
    const res = await create(b, {
      email: "Jane.Doe@Acme-Tools.com",
      firstName: "Jane",
      timeZone: "America/Toronto",
      country: "ca",
    }).expect(201);
    expect(res.body).toMatchObject({
      email: "jane.doe@acme-tools.com",
      firstName: "Jane",
      lastName: null,
      timeZone: "America/Toronto",
      country: "CA",
      status: "active",
      consentBasis: "none",
      company: { name: "Acme Tools", domain: "acme-tools.com" },
    });

    // A second contact at the same domain links the same company.
    const second = await create(b, { email: "bob@acme-tools.com" }).expect(201);
    expect(second.body.company.id).toBe(res.body.company.id);

    const got = await b.get(`/v1/contacts/${res.body.id as string}`).expect(200);
    expect(got.body.email).toBe("jane.doe@acme-tools.com");

    const companies = await b.get("/v1/companies?q=acme").expect(200);
    expect(companies.body.items).toEqual([
      expect.objectContaining({ name: "Acme Tools", domain: "acme-tools.com", contactCount: 2 }),
    ]);
  });

  it("uses an explicit company domain and name, and never makes free-mail companies", async () => {
    const { b } = await signedUp(app);
    const free = await create(b, { email: "someone@gmail.com" }).expect(201);
    expect(free.body.company).toBeNull();

    const explicit = await create(b, {
      email: "pat@gmail.com",
      companyDomain: "Globex.io",
      companyName: "Globex Corporation",
    }).expect(201);
    expect(explicit.body.company).toMatchObject({
      name: "Globex Corporation",
      domain: "globex.io",
    });

    const list = await b.get("/v1/companies").expect(200);
    expect(list.body.items.map((c: { domain: string }) => c.domain)).toEqual(["globex.io"]);
  });

  it("rejects an invalid time zone and invalid fields", async () => {
    const { b } = await signedUp(app);
    const tz = await create(b, { email: "a@acme.com", timeZone: "Mars/Olympus" }).expect(400);
    expect(tz.body.code).toBe("validation_error");
    expect(tz.body.details).toEqual([{ path: "timeZone", message: expect.any(String) }]);

    const email = await create(b, { email: "not-an-email" }).expect(400);
    expect(email.body.details[0].path).toBe("email");
  });

  it("refuses a duplicate email that differs only in case", async () => {
    const { b } = await signedUp(app);
    const first = await create(b, { email: "jane@acme.com" }).expect(201);
    const dup = await create(b, { email: "JANE@Acme.com" }).expect(409);
    expect(dup.body.code).toBe("contact_exists");
    expect(dup.body.details).toEqual({ contactId: first.body.id });
  });

  it("lists newest first, searches, and paginates with a cursor", async () => {
    const { b } = await signedUp(app);
    await create(b, { email: "ann@alpha.com", firstName: "Ann", lastName: "Lee" }).expect(201);
    await create(b, { email: "ben@beta.com", firstName: "Ben" }).expect(201);
    await create(b, { email: "cy@gamma.com", firstName: "Cy", companyName: "100%_Real" }).expect(
      201,
    );

    const page1 = await b.get("/v1/contacts?limit=2").expect(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.items.map((c: { email: string }) => c.email)).toEqual([
      "cy@gamma.com",
      "ben@beta.com",
    ]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await b
      .get(`/v1/contacts?limit=2&cursor=${page1.body.nextCursor as string}`)
      .expect(200);
    expect(page2.body.items.map((c: { email: string }) => c.email)).toEqual(["ann@alpha.com"]);
    expect(page2.body.nextCursor).toBeNull();

    const byName = await b.get("/v1/contacts?q=ANN").expect(200);
    expect(byName.body.total).toBe(1);
    expect(byName.body.items[0].email).toBe("ann@alpha.com");
    const byFullName = await b.get("/v1/contacts?q=ann%20lee").expect(200);
    expect(byFullName.body.total).toBe(1);
    const byCompany = await b.get("/v1/contacts?q=Beta").expect(200);
    expect(byCompany.body.items.map((c: { email: string }) => c.email)).toEqual(["ben@beta.com"]);

    // `%` and `_` match literally.
    const literal = await b.get("/v1/contacts?q=0%25_r").expect(200);
    expect(literal.body.items.map((c: { email: string }) => c.email)).toEqual(["cy@gamma.com"]);
    const wildcard = await b.get("/v1/contacts?q=%25a").expect(200);
    expect(wildcard.body.total).toBe(0);
    expect((await b.get("/v1/contacts?q=_").expect(200)).body.total).toBe(1);

    await b.get("/v1/contacts?cursor=garbage").expect(400);
  });

  it("updates fields and re-links the company when the email changes", async () => {
    const { b } = await signedUp(app);
    const c = await create(b, { email: "kim@initech.com", title: "VP" }).expect(201);
    const other = await create(b, { email: "lee@initech.com" }).expect(201);
    const id = c.body.id as string;

    const res = await b
      .patch(`/v1/contacts/${id}`, { firstName: "Kim", title: null, email: "kim@hooli.com" })
      .expect(200);
    expect(res.body).toMatchObject({
      firstName: "Kim",
      title: null,
      email: "kim@hooli.com",
      company: { domain: "hooli.com", name: "Hooli" },
    });
    expect(new Date(res.body.updatedAt as string).getTime()).toBeGreaterThanOrEqual(
      new Date(c.body.updatedAt as string).getTime(),
    );

    const dup = await b.patch(`/v1/contacts/${id}`, { email: "LEE@initech.com" }).expect(409);
    expect(dup.body.code).toBe("contact_exists");
    expect(dup.body.details.contactId).toBe(other.body.id);

    await b.patch(`/v1/contacts/${id}`, { timeZone: "Nowhere/Land" }).expect(400);
    await b.patch("/v1/contacts/not-a-uuid", { firstName: "X" }).expect(400);
  });

  it("only owners, admins and managers can delete; ?suppress=true adds a suppression", async () => {
    const { b: owner } = await signedUp(app);
    const rep = await joinAs(app, owner, "rep");
    const manager = await joinAs(app, owner, "manager");

    const one = await create(rep, { email: "one@acme.com" }).expect(201);
    const two = await create(rep, { email: "two@acme.com" }).expect(201);

    await rep.delete(`/v1/contacts/${one.body.id as string}`).expect(403);
    await manager.delete(`/v1/contacts/${one.body.id as string}`).expect(200);
    await owner.get(`/v1/contacts/${one.body.id as string}`).expect(404);
    await manager.delete(`/v1/contacts/${one.body.id as string}`).expect(404);

    await owner.delete(`/v1/contacts/${two.body.id as string}?suppress=true`).expect(200);
    const list = await owner.get("/v1/suppressions").expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ value: "two@acme.com", reason: "other" }),
    ]);
  });

  it("keeps workspaces isolated", async () => {
    const { b: a } = await signedUp(app, { workspaceName: "A" });
    const { b: other } = await signedUp(app, { workspaceName: "B" });
    const secret = await create(a, {
      email: "secret@shared-domain.com",
      firstName: "Secret",
    }).expect(201);
    const id = secret.body.id as string;

    await other.get(`/v1/contacts/${id}`).expect(404);
    await other.patch(`/v1/contacts/${id}`, { firstName: "Hacked" }).expect(404);
    await other.delete(`/v1/contacts/${id}`).expect(404);

    const list = await other.get("/v1/contacts").expect(200);
    expect(list.body.total).toBe(0);
    const search = await other.get("/v1/contacts?q=secret").expect(200);
    expect(search.body.items).toEqual([]);
    expect((await other.get("/v1/companies").expect(200)).body.items).toEqual([]);

    // Same email in another workspace is fine and links that workspace's own company.
    const mine = await create(other, { email: "secret@shared-domain.com" }).expect(201);
    expect(mine.body.company.id).not.toBe(secret.body.company.id);
    const still = await a.get(`/v1/contacts/${id}`).expect(200);
    expect(still.body.firstName).toBe("Secret");
  });
});
