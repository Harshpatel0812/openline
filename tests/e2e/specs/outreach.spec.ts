import { expect, test, type Page } from "@playwright/test";

// Sprint 3 journey (OL-E3 sending): verify email → mailing address → connect an SMTP mailbox →
// import contacts → activate a sequence → enroll → the engine sends → one-click unsubscribe.
// All mail lands in the local sink (support/mail-sink.mjs); nothing leaves the machine.

const SINK = "http://127.0.0.1:2580/messages";
type SinkMessage = { to: string[]; raw: string };

const decodeQuotedPrintable = (s: string) =>
  s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

async function waitForMail(match: (m: SinkMessage) => boolean, timeoutMs: number) {
  let found: SinkMessage | undefined;
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(SINK)).json()) as SinkMessage[];
        found = all.find(match);
        return Boolean(found);
      },
      { timeout: timeoutMs, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return decodeQuotedPrintable(found!.raw);
}

async function sentTo(address: string) {
  const all = (await (await fetch(SINK)).json()) as SinkMessage[];
  return all.some((m) => m.to.includes(address));
}

/** Calls the API through the web app's proxy with the page's session cookie. */
function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(`/api/v1${p}`, {
        method: m,
        headers: { "content-type": "application/json", "x-openline-csrf": "1" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path, body] as const,
  );
}

test("verify email, connect a mailbox, send a sequence step, and honour one-click unsubscribe", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const owner = `harsh${stamp}@openline-demo.com`;
  const jane = `jane${stamp}@acme-tools.com`;
  const luc = `luc${stamp}@maple.ca`;
  const blocked = `sam${stamp}@competitor${stamp}.io`;

  // 1. Sign up in the UI; the verification email arrives; its link verifies the address.
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Harsh Patel");
  await page.getByLabel("Work email").fill(owner);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByLabel("Workspace name").fill(`Openline Demo ${stamp}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app\//);

  const verifyMail = await waitForMail(
    (m) => m.to.includes(owner) && /verify/i.test(m.raw),
    15_000,
  );
  const verifyLink = verifyMail.match(
    /https?:\/\/[^\s"<>]+\/verify-email\?token=[A-Za-z0-9_-]+/,
  )?.[0];
  expect(verifyLink).toBeTruthy();
  await page.goto(verifyLink!);
  await expect(page.getByText(/verified/i).first()).toBeVisible();
  expect((await api(page, "GET", "/auth/me")).body.user.emailVerified).toBe(true);

  // 2. CAN-SPAM mailing address, an SMTP mailbox (real login check), a suppression and contacts.
  const settings = await api(page, "PATCH", "/workspace", {
    mailingAddress: "30 Hudson St, Jersey City, NJ 07302, USA",
  });
  expect(settings.status).toBe(200);
  const mailbox = await api(page, "POST", "/mailboxes/smtp", {
    email: owner,
    displayName: "Harsh from Openline",
    host: "127.0.0.1",
    port: 2525,
    secure: false,
    username: "harsh",
    password: "app-password",
    dailyCap: 50,
  });
  expect(mailbox.status, JSON.stringify(mailbox.body)).toBe(201);
  expect(JSON.stringify(mailbox.body)).not.toContain("app-password");

  await api(page, "POST", "/suppressions", {
    value: `@competitor${stamp}.io`,
    reason: "competitor",
  });
  const csv =
    "email,first name,company,country\n" +
    `${jane},Jane,Acme Tools,US\n${luc},Luc,Maple Co,CA\n${blocked},Sam,Competitor,US\n`;
  const imported = await api(page, "POST", "/contacts/import", {
    csv,
    duplicates: "skip",
    confirmLawfulBasis: true,
  });
  expect(imported.status).toBe(200);

  // 3. A two-step sequence open all week (so the engine sends straight away), activated.
  const sequence = await api(page, "POST", "/sequences", {
    name: "Jersey City intro",
    sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], startHour: 0, endHour: 24 },
    steps: [
      {
        delayDays: 0,
        subject: "Quick question, {{firstName|there}}",
        body: "Hi {{firstName|there}},\n\nWorth a 15-minute chat about {{company}}?\n\n{{senderName}}",
        threadWithPrevious: false,
      },
      {
        delayDays: 3,
        subject: "Following up",
        body: "Hi {{firstName}}, bumping this.",
        threadWithPrevious: true,
      },
    ],
  });
  expect(sequence.status).toBe(201);
  const sequenceId = sequence.body.id as string;
  expect(
    (await api(page, "POST", `/sequences/${sequenceId}/status`, { status: "active" })).body.status,
  ).toBe("active");

  // 4. Enroll everyone: the suppressed contact and the Canadian contact without consent are skipped.
  const contacts = (await api(page, "GET", "/contacts?limit=50")).body.items as {
    id: string;
    email: string;
  }[];
  const enroll = await api(page, "POST", `/sequences/${sequenceId}/enroll`, {
    contactIds: contacts.map((c) => c.id),
    mailboxId: mailbox.body.id,
  });
  expect(enroll.status).toBe(200);
  expect(enroll.body.enrolled, JSON.stringify(enroll.body)).toBe(1);

  // 5. The engine sends step 1 with the compliance footer and one-click unsubscribe headers.
  const outreach = await waitForMail((m) => m.to.includes(jane), 60_000);
  expect(outreach).toMatch(/^Subject: Quick question, Jane/m);
  expect(outreach).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  expect(outreach).toContain("30 Hudson St, Jersey City");
  expect(await sentTo(luc)).toBe(false);
  expect(await sentTo(blocked)).toBe(false);

  await page.goto(`/app/sequences/${sequenceId}?tab=enrollments`);
  await expect(page.getByText("Step 2 of 2")).toBeVisible();

  // 6. One-click unsubscribe exactly as a mailbox provider does it (RFC 8058 POST).
  const unsubscribeUrl = outreach
    .replace(/\r?\n[ \t]+/g, " ")
    .match(/List-Unsubscribe: <([^>]+)>/)?.[1];
  expect(unsubscribeUrl).toBeTruthy();
  const unsub = await fetch(unsubscribeUrl!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(unsub.status).toBe(200);

  const janeContact = contacts.find((c) => c.email === jane)!;
  const enrollments = await api(page, "GET", `/contacts/${janeContact.id}/enrollments`);
  expect(enrollments.body.map((e: { state: string }) => e.state)).toEqual(["unsubscribed"]);
  expect((await api(page, "GET", `/contacts/${janeContact.id}`)).body.status).toBe("unsubscribed");

  // The footer link shows a confirmation page that masks the address.
  const footerLink = outreach.match(/https?:\/\/[^\s"<>]+\/u\/[A-Za-z0-9._-]+/)?.[0];
  await page.goto(footerLink!);
  await expect(page.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
  await expect(page.getByText(jane)).toHaveCount(0);
});
