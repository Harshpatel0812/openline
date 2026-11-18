import { expect, test, type Locator, type Page } from "@playwright/test";

// Sprint 7 (OL-E8): CRM sync against the fake HubSpot (tests/e2e/support/fake-crm.mjs). Connect via
// the fake OAuth consent, map stages, preview (nothing written), import, badges on records, an
// Openline edit pushed to the CRM, a per-field source-of-truth override, a record error in the sync
// log, pause / resume and disconnect (revokes). No real network.

const FAKE = process.env.FAKE_CRM_URL ?? "http://127.0.0.1:4900";

/** Calls the API through the web app's proxy with the page's session cookie. */
function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(`/api/v1${p}`, {
        method: m,
        headers: { "content-type": "application/json", "x-openline-csrf": "1" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
    },
    [method, path, body] as const,
  ) as Promise<{ status: number; body: T }>;
}

interface HsRecord {
  id: string;
  properties: Record<string, string | null>;
  archived: boolean;
}
interface FakeState {
  hubspot: {
    contacts: HsRecord[];
    companies: HsRecord[];
    deals: HsRecord[];
    revoked: number;
  };
  writes: number;
}

async function fake<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${FAKE}/_fake/${path}`, {
    method,
    data: body === undefined ? undefined : body,
  });
  expect(res.status(), `${method} ${path}: ${await res.text()}`).toBeLessThan(300);
  return (await res.json()) as T;
}

const fakeState = (page: Page) => fake<FakeState>(page, "GET", "state");

const SINK = "http://127.0.0.1:2580/messages";
type SinkMessage = { to: string[]; raw: string };

/** Connecting a CRM needs a verified email: follow the link from the mail sink. */
async function verifyEmail(page: Page, email: string) {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(SINK)).json()) as SinkMessage[];
        const raw = all
          .find((m) => m.to.includes(email) && /verify/i.test(m.raw))
          ?.raw.replace(/=\r?\n/g, "")
          .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        link = raw?.match(/https?:\/\/[^\s"<>]+\/verify-email\?token=[A-Za-z0-9_-]+/)?.[0];
        return Boolean(link);
      },
      { timeout: 15_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await page.goto(link!);
  await expect(page.getByText(/verified/i).first()).toBeVisible();
}

async function signUp(page: Page, prefix: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${prefix}${stamp}@openline-demo.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Harsh Patel");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByLabel("Workspace name").fill(`S7 ${prefix} ${stamp}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app\//);
  return { stamp, email };
}

/** Picks the first real option in every select of `scope` that is still "Not mapped". */
async function mapRemaining(scope: Locator) {
  const selects = scope.locator("select");
  const n = await selects.count();
  for (let i = 0; i < n; i += 1) {
    const s = selects.nth(i);
    if ((await s.inputValue()) !== "") continue;
    const value = await s
      .locator("option")
      .evaluateAll((opts) => (opts as HTMLOptionElement[]).find((o) => o.value)?.value ?? "");
    await s.selectOption(value);
  }
}

const status = (page: Page) => page.getByTestId("crm-card-hubspot").getByTestId("crm-status");

async function syncNow(page: Page) {
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Sync started")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await fake(page, "POST", "reset");
});

test("connect HubSpot, preview, import, push an edit, override a conflict, see an error, pause and disconnect", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { stamp, email } = await signUp(page, "crm");
  await verifyEmail(page, email);

  // Openline side: one contact that HubSpot also has (must link, not duplicate).
  const shared = `grace${stamp}@brightwell.test`;
  const contact = await api<{ id: string }>(page, "POST", "/contacts", {
    email: shared,
    firstName: "Grace",
    lastName: "Hopper",
  });
  expect(contact.status).toBe(201);

  // HubSpot side: the same person, a new one, a company and a deal in the default pipeline.
  const company = await fake<{ id: string }>(page, "POST", "hubspot/companies", {
    name: "Brightwell",
    domain: "brightwell.test",
  });
  const hsGrace = await fake<{ id: string }>(page, "POST", "hubspot/contacts", {
    email: shared,
    firstname: "Grace",
    lastname: "Hopper",
    associations: { companies: [company.id] },
  });
  await fake(page, "POST", "hubspot/contacts", {
    email: `linus${stamp}@brightwell.test`,
    firstname: "Linus",
    lastname: "Pauling",
    associations: { companies: [company.id] },
  });
  const hsDeal = await fake<{ id: string }>(page, "POST", "hubspot/deals", {
    dealname: "Brightwell renewal",
    amount: "1200.00",
    deal_currency_code: "USD",
    pipeline: "default",
    dealstage: "qualifiedtobuy",
    associations: { companies: [company.id], contacts: [hsGrace.id] },
  });

  // Settings → Integrations is in the settings nav.
  await page.goto("/app/settings/team");
  await page.getByRole("link", { name: "Integrations" }).click();
  await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
  await expect(page.getByTestId("crm-card-pipedrive")).toContainText("Not connected");

  // Connect through the fake consent screen (auto-approves) and come back.
  await page.getByRole("button", { name: "Connect HubSpot" }).click();
  await expect(page).toHaveURL(/\/app\/settings\/integrations$/, { timeout: 15_000 });
  await expect(page.getByText("HubSpot connected")).toBeVisible();
  await expect(status(page)).toHaveText("Needs setup");
  // One CRM per workspace.
  await expect(page.getByRole("button", { name: "Connect Pipedrive" })).toBeDisabled();

  // Stages: pick the pipeline; Won/Lost are pre-filled by kind; map the rest.
  const stagesCard = page.locator("form").filter({ has: page.getByLabel("HubSpot pipeline") });
  await page.getByLabel("HubSpot pipeline").selectOption({ label: "Sales Pipeline" });
  await expect(stagesCard.getByLabel("Won in Openline")).not.toHaveValue("");
  await page.getByRole("button", { name: "Save stage mapping" }).click();
  await expect(page.getByText("Map every stage before saving.")).toBeVisible();
  await expect(stagesCard.getByText("Choose a stage").first()).toBeVisible();
  await mapRemaining(stagesCard);
  await stagesCard.getByLabel("Qualified To Buy in HubSpot").selectOption({ label: "Qualified" });
  await page.getByRole("button", { name: "Save stage mapping" }).click();
  await expect(page.getByText("Stage mapping saved")).toBeVisible();

  // Field mapping: a custom mapping (contact tier ⇄ HubSpot "Tier").
  await page.getByRole("button", { name: "Add field mapping" }).click();
  const custom = page.getByTestId(/^field-row-contact-custom\./).last();
  await custom.getByLabel("Openline custom field").fill("tier");
  await custom.getByLabel("HubSpot property").selectOption({ label: "Tier" });
  await page.getByRole("button", { name: "Save field mapping" }).click();
  await expect(page.getByText("Field mapping saved")).toBeVisible();

  // Dry run: counts, and nothing written to either side.
  const writesBefore = (await fakeState(page)).writes;
  await page.getByRole("button", { name: "Run preview" }).click();
  const counts = page.getByTestId("preview-counts");
  await expect(counts).toBeVisible();
  await expect(page.getByTestId("preview-contact-link")).toContainText("1");
  await expect(page.getByTestId("preview-contact-create")).toContainText("1");
  await expect(page.getByTestId("preview-deal-create")).toContainText("1");
  expect((await fakeState(page)).writes).toBe(writesBefore);
  const contacts = await api<{ total: number }>(page, "GET", "/contacts");
  expect(contacts.body.total).toBe(1);

  // Import needs the lawful-basis confirmation.
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(
    page.getByText("Confirm you have a lawful basis to contact these people"),
  ).toBeVisible();
  await page.getByLabel(/I confirm we have a lawful basis/).check();
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(page.getByText("Import started")).toBeVisible();
  await expect(status(page)).toHaveText("Syncing", { timeout: 60_000 });
  await expect(page.getByTestId("crm-announcer")).toContainText(/Syncing with HubSpot/);

  // Records: linked (not duplicated) and badged, with a link to the CRM record.
  await page.goto("/app/contacts");
  await expect(page.getByRole("link", { name: "Grace Hopper", exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Linus Pauling", exact: true })).toBeVisible();
  const graceRow = page.getByRole("row").filter({ hasText: shared });
  await expect(graceRow.getByTestId("crm-badge")).toContainText("Synced with HubSpot");
  await page.goto(`/app/contacts/${contact.body.id}`);
  const badge = page.getByTestId("crm-badge").first();
  await expect(badge).toContainText("Synced with HubSpot");
  await expect(badge).toHaveAttribute("href", /hubspot/);
  await expect(badge).toHaveAttribute("target", "_blank");

  await page.goto("/app/companies");
  await expect(
    page.getByRole("row").filter({ hasText: "Brightwell" }).getByTestId("crm-badge"),
  ).toContainText("Synced with HubSpot");

  await page.goto("/app/deals?view=list");
  const dealRow = page.getByRole("row").filter({ hasText: "Brightwell renewal" });
  await expect(dealRow.getByTestId("crm-badge")).toContainText("Synced with HubSpot");
  await expect(dealRow).toContainText("Qualified");
  await dealRow.getByRole("link", { name: "Brightwell renewal", exact: true }).click();
  await expect(page.getByTestId("crm-badge").first()).toContainText("Synced with HubSpot");
  await expect(page).toHaveURL(/\/app\/deals\/[0-9a-f-]{36}$/);
  const dealId = page.url().split("/").pop()!;

  // Edit the deal in Openline → pushed to HubSpot on the next sync.
  const edited = await api(page, "PATCH", `/deals/${dealId}`, { name: "Brightwell renewal 2027" });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  await page.goto("/app/settings/integrations");
  await syncNow(page);
  await expect
    .poll(
      async () =>
        (await fakeState(page)).hubspot.deals.find((d) => d.id === hsDeal.id)?.properties.dealname,
      { timeout: 60_000 },
    )
    .toBe("Brightwell renewal 2027");

  // Conflict override: deal name pinned to "HubSpot wins". Both sides change it, Openline last;
  // HubSpot's value still wins.
  await page.getByRole("tab", { name: "Deals" }).click();
  await page.getByLabel("Source of truth for Name").selectOption({ label: "HubSpot wins" });
  await page.getByRole("button", { name: "Save field mapping" }).click();
  await expect(page.getByText("Field mapping saved")).toBeVisible();
  await fake(page, "PATCH", `hubspot/deals/${hsDeal.id}`, { dealname: "Named in HubSpot" });
  await page.waitForTimeout(1_100);
  await api(page, "PATCH", `/deals/${dealId}`, { name: "Named in Openline" });
  await page.reload();
  await syncNow(page);
  await expect
    .poll(async () => (await api<{ name: string }>(page, "GET", `/deals/${dealId}`)).body.name, {
      timeout: 60_000,
    })
    .toBe("Named in HubSpot");
  expect(
    (await fakeState(page)).hubspot.deals.find((d) => d.id === hsDeal.id)?.properties.dealname,
  ).toBe("Named in HubSpot");

  // A record error: a EUR deal can't go to a USD-only HubSpot (amount not pushed).
  const eur = await api<{ id: string }>(page, "POST", "/deals", {
    name: "Euro deal",
    amountMinor: 50000,
    currency: "EUR",
    primaryContactId: contact.body.id,
  });
  expect(eur.status, JSON.stringify(eur.body)).toBe(201);
  await page.reload();
  await syncNow(page);
  await expect(page.getByTestId("crm-error-count")).toHaveText(/^[1-9]/, { timeout: 60_000 });
  await page.getByTestId("crm-error-count").getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Sync log", level: 1 })).toBeVisible();
  const errorRow = page.getByTestId("sync-error").filter({ hasText: "Currency" });
  await expect(errorRow).toBeVisible();
  await expect(errorRow.getByRole("link", { name: "Open the deal in Openline" })).toHaveAttribute(
    "href",
    `/app/deals/${eur.body.id}`,
  );
  await expect(page.getByTestId("sync-run").first()).toBeVisible();
  // Filters: no company errors; back to deals.
  await page.getByLabel("Record type").selectOption({ label: "Companies" });
  await expect(page.getByText("No open errors")).toBeVisible();
  await page.getByLabel("Record type").selectOption({ label: "Deals" });
  await errorRow.getByRole("button", { name: /^Dismiss/ }).click();
  await expect(page.getByText("Error dismissed")).toBeVisible();
  await expect(page.getByTestId("sync-error").filter({ hasText: "Currency" })).toHaveCount(0);
  await page.getByLabel("Status").selectOption({ label: "Open and resolved" });
  await expect(
    page
      .getByTestId("sync-error")
      .filter({ hasText: "Currency" })
      .getByText("Resolved", { exact: true }),
  ).toBeVisible();

  // Pause and resume.
  await page.goto("/app/settings/integrations");
  await page.getByRole("button", { name: "Pause sync" }).click();
  await expect(status(page)).toHaveText("Paused");
  await expect(page.getByTestId("crm-announcer")).toContainText(/paused/i);
  await page.goto("/app/contacts");
  await expect(
    page.getByRole("row").filter({ hasText: shared }).getByTestId("crm-badge"),
  ).toContainText("Sync paused");
  await page.goto("/app/settings/integrations");
  await page.getByRole("button", { name: "Resume sync" }).click();
  await expect(status(page)).toHaveText("Syncing");

  // Disconnect: confirm, revoke at HubSpot, nothing deleted on either side.
  const before = await fakeState(page);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Disconnect HubSpot?" });
  await expect(dialog).toContainText("Nothing is deleted in HubSpot or in Openline.");
  await dialog.getByRole("button", { name: "Disconnect HubSpot" }).click();
  await expect(page.getByText("Disconnected HubSpot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect HubSpot" })).toBeEnabled();
  const after = await fakeState(page);
  expect(after.hubspot.revoked).toBeGreaterThan(before.hubspot.revoked);
  expect(after.hubspot.contacts.filter((c) => !c.archived)).toHaveLength(
    before.hubspot.contacts.filter((c) => !c.archived).length,
  );
  expect((await api<{ total: number }>(page, "GET", "/contacts")).body.total).toBe(2);
});

test("a tampered OAuth return shows why nothing was connected", async ({ page }) => {
  await signUp(page, "crmstate");
  await page.goto("/app/settings/integrations?error=state_invalid");
  await expect(page.getByText("The CRM wasn't connected")).toBeVisible();
  await expect(page.getByText("The sign-in link was not valid")).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings\/integrations$/);
  await expect(page.getByRole("button", { name: "Connect HubSpot" })).toBeEnabled();
});

test("Integrations and the sync log fit a 375 px screen without sideways scrolling", async ({
  page,
}) => {
  await signUp(page, "crmmobile");
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/app/settings/integrations", "/app/settings/integrations/log"]) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
