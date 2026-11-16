import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Link audit and the "picked a plan on /pricing" journey (bug: the plan vanished after sign-up or
// sign-in). (a) every public page reachable from / and every #anchor; (b) every page reachable
// from the app shell and settings nav; (c) the plan survives sign-up and sign-in.

const PASSWORD = "correct horse battery staple";
let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}-${Date.now()}@example.com`;
}

async function signUpViaApi(request: APIRequestContext, email: string, extra: object = {}) {
  const res = await request.post("/api/v1/auth/signup", {
    headers: { "x-openline-csrf": "1" },
    data: { name: "Link Checker", email, password: PASSWORD, workspaceName: "Links Co", ...extra },
  });
  expect(res.status(), await res.text()).toBe(201);
}

/** Every href on the page (including hidden ones, e.g. the closed mobile menu), resolved. */
async function hrefsOn(page: Page, scope = "body"): Promise<string[]> {
  return page
    .locator(scope)
    .first()
    .evaluate((root) =>
      Array.from(root.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href),
    );
}

/** Ids on the page, for checking #anchors. */
async function idsOn(page: Page): Promise<Set<string>> {
  return new Set(
    await page.evaluate(() => Array.from(document.querySelectorAll("[id]"), (el) => el.id)),
  );
}

/** Path + query of a same-origin URL (no hash), or null for other origins and the API. */
function internal(url: URL, origin: string): string | null {
  if (url.origin !== origin || url.pathname.startsWith("/api/")) return null;
  return url.pathname + url.search;
}

test("(a) every public link from / works, and every #anchor exists", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL!).origin;
  const queue = ["/"];
  const status = new Map<string, number>();
  const ids = new Map<string, Set<string>>();
  const foundOn = new Map<string, string>();
  const anchors: { from: string; target: string; hash: string }[] = [];
  const external = new Set<string>();

  while (queue.length) {
    const path = queue.shift()!;
    if (status.has(path)) continue;
    const response = await page.goto(path);
    status.set(path, response?.status() ?? 0);
    if (!response || response.status() >= 400) continue;
    // Signed out, /app links end on /login: check the status, don't crawl the app here.
    const landed = new URL(page.url());
    if (landed.pathname !== new URL(path, origin).pathname && landed.pathname === "/login") {
      continue;
    }
    ids.set(path, await idsOn(page));
    for (const href of await hrefsOn(page)) {
      const url = new URL(href);
      if (url.protocol === "mailto:" || url.protocol === "tel:") continue;
      const target = internal(url, origin);
      if (target === null) {
        if (url.origin !== origin) external.add(url.href);
        continue;
      }
      if (url.hash)
        anchors.push({ from: path, target, hash: decodeURIComponent(url.hash.slice(1)) });
      if (!foundOn.has(target)) foundOn.set(target, path);
      if (!status.has(target)) queue.push(target);
    }
  }

  const broken = [...status].filter(([, s]) => s >= 400 || s === 0);
  expect(
    broken.map(([p, s]) => `${s} ${p} (linked from ${foundOn.get(p)})`),
    "broken links",
  ).toEqual([]);

  // The crawl reached the parts of the site people navigate by.
  for (const p of ["/features", "/pricing", "/help", "/blog", "/security", "/privacy", "/terms"]) {
    expect(status.get(p), p).toBe(200);
  }
  expect([...status.keys()].some((p) => p.startsWith("/help/"))).toBe(true);
  expect([...status.keys()].some((p) => p.startsWith("/blog/"))).toBe(true);
  expect([...status.keys()].some((p) => p.startsWith("/signup?plan="))).toBe(true);

  for (const { target } of anchors) {
    if (!ids.has(target)) {
      await page.goto(target);
      ids.set(target, await idsOn(page));
    }
  }
  const missing = anchors.filter(({ target, hash }) => !ids.get(target)?.has(hash));
  expect(
    missing.map(({ from, target, hash }) => `${target}#${hash} (linked from ${from})`),
    "missing anchors",
  ).toEqual([]);

  // The tab icon (and the /favicon.ico browsers ask for by default) resolve.
  await page.goto("/");
  const icons = await page
    .locator('link[rel~="icon"]')
    .evaluateAll((els) => els.map((el) => (el as HTMLLinkElement).href));
  expect(icons.length).toBeGreaterThan(0);
  for (const href of [...icons, `${origin}/favicon.ico`]) {
    expect((await page.request.get(href)).status(), href).toBeLessThan(400);
  }

  // External links are not fetched (no network in CI), only checked to be https.
  for (const href of external) expect(href, href).toMatch(/^https:\/\//);
});

test("(b) every link in the app shell and settings works when signed in", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL!).origin;
  // page.request shares the browser context's cookies, so this signs the page in.
  await signUpViaApi(page.request, uniqueEmail("crawler"));

  const errors: string[] = [];
  let current = "";
  page.on("pageerror", (e) => errors.push(`${current}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${current}: ${m.text()}`);
  });
  // Name the failing URL (the console only says "Failed to load resource").
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`${current}: ${r.status()} ${r.url()}`);
  });

  // A contact, its company and a deal, so the crawl reaches the deal, contact and company pages.
  const call = (path: string, data: object) =>
    page.request.post(`/api/v1${path}`, { headers: { "x-openline-csrf": "1" }, data });
  const contact = await call("/contacts", {
    email: uniqueEmail("buyer"),
    firstName: "Dana",
    lastName: "Lee",
    title: "VP Sales",
    companyName: "Brightwell",
  });
  expect(contact.status(), await contact.text()).toBe(201);
  const deal = await call("/deals", {
    name: "Brightwell — new deal",
    primaryContactId: ((await contact.json()) as { id: string }).id,
  });
  expect(deal.status(), await deal.text()).toBe(201);
  const dealId = ((await deal.json()) as { id: string }).id;

  current = "/app";
  await page.goto("/app");
  await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
  const start = new Set<string>();
  for (const scope of ["aside", "header"]) {
    for (const href of await hrefsOn(page, scope)) {
      const target = internal(new URL(href), origin);
      if (target) start.add(target);
    }
  }
  for (const p of [
    "/app",
    "/app/inbox",
    "/app/deals",
    "/app/settings/team",
    "/app/settings/pipeline",
    "/app/settings/billing",
  ]) {
    expect([...start], p).toContain(p);
  }

  const queue = [...start];
  const seen = new Set<string>();
  const problems: string[] = [];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    current = path;
    const response = await page.goto(path);
    const code = response?.status() ?? 0;
    if (code >= 400 || code === 0) {
      problems.push(`${code} ${path}`);
      continue;
    }
    if (!new URL(page.url()).pathname.startsWith("/app")) continue; // e.g. a help link: status only
    await expect(page.locator("main h1").first(), path).toBeVisible();
    await page.waitForLoadState("networkidle");
    const headings = await page.locator("h1, h2").allInnerTexts();
    if (headings.some((h) => /\b404\b|not found/i.test(h))) problems.push(`not found: ${path}`);
    for (const href of await hrefsOn(page, "main")) {
      const target = internal(new URL(href), origin);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  expect(problems).toEqual([]);
  expect(errors).toEqual([]);
  expect(seen.size).toBeGreaterThan(8);
  // The pipeline pages were reached from the shell, and the deal page from the board.
  for (const p of ["/app/deals", `/app/deals/${dealId}`, "/app/settings/pipeline"]) {
    expect([...seen], p).toContain(p);
  }
  expect([...seen].some((p) => p.startsWith("/app/contacts/"))).toBe(true);
});

/** Picks a plan on /pricing (with the billing toggle) and clicks its "Start free trial". */
async function pickPlan(page: Page, plan: string, billing: "monthly" | "annual") {
  await page.goto("/pricing");
  if (billing === "annual") {
    await page.getByText("Annual (2 months free)").click();
  }
  await page.getByTestId(`cta-${plan}`).click();
  await expect(page).toHaveURL(new RegExp(`/signup\\?plan=${plan}&billing=${billing}$`));
}

test("(c) a plan picked on /pricing survives sign-up", async ({ page }) => {
  await pickPlan(page, "team", "annual");
  const summary = page.getByTestId("plan-summary");
  await expect(summary).toContainText("You're starting a free 14-day trial.");
  await expect(summary).toContainText("Plan you picked: Team — $99/mo billed annually");
  await expect(summary).toContainText("You won't be charged during the trial");
  await expect(summary.getByRole("link", { name: "Change plan" })).toHaveAttribute(
    "href",
    "/pricing?plan=team&billing=annual",
  );

  await page.getByLabel("Your name").fill("Plan Picker");
  await page.getByLabel("Work email").fill(uniqueEmail("picker"));
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Workspace name").fill("Picked Co");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page).toHaveURL(/\/app\/settings\/billing$/);
  await expect(page.getByRole("heading", { name: "Plan & billing", level: 1 })).toBeVisible();
  await expect(page.getByTestId("chosen-plan")).toHaveText("Team — $99/mo billed annually");
  await expect(page.getByTestId("trial-status")).toHaveText("Free trial: 14 days left");
  await expect(page.getByText("Payments aren't switched on yet")).toBeVisible();
  await expect(page.getByTestId("confirm-plan")).toHaveCount(0);
  await expect(page.getByTestId("trial-badge").first()).toHaveText("Team trial: 14 days left");
});

test("(c) a plan picked on /pricing survives signing in, and is saved only on confirm", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("returning");
  await signUpViaApi(request, email); // `request` has its own cookies: the page stays signed out.

  await pickPlan(page, "team", "monthly");
  await page.getByRole("link", { name: "Sign in", exact: true }).last().click();
  await expect(page).toHaveURL(/\/login\?plan=team&billing=monthly&next=/);
  // "Start a free trial" from here keeps the plan too.
  await expect(page.getByRole("link", { name: "Start a free trial" })).toHaveAttribute(
    "href",
    "/signup?plan=team&billing=monthly",
  );
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/app\/settings\/billing\?plan=team&billing=monthly$/);
  await expect(page.getByTestId("chosen-plan")).toHaveText("No plan chosen yet");
  const confirm = page.getByTestId("confirm-plan");
  await expect(confirm).toContainText("Team — $119/mo billed monthly");
  await expect(page.getByTestId("trial-badge").first()).toHaveText("Trial: 14 days left");

  await confirm.getByRole("button", { name: "Save my choice" }).click();
  await expect(page.getByTestId("chosen-plan")).toHaveText("Team — $119/mo billed monthly");
  await expect(page).toHaveURL(/\/app\/settings\/billing$/);
  await expect(page.getByTestId("trial-badge").first()).toHaveText("Team trial: 14 days left");

  // Change it later from the plan cards: still needs a confirmation.
  await page.getByText("Annual (2 months free)").click();
  await page
    .getByTestId("billing-plan-growth")
    .getByRole("button", { name: "Choose Growth" })
    .click();
  await expect(page.getByTestId("chosen-plan")).toHaveText("Team — $119/mo billed monthly");
  await page.getByRole("button", { name: "Save my choice" }).click();
  await expect(page.getByTestId("chosen-plan")).toHaveText("Growth — $232/mo billed annually");
  await expect(page.getByTestId("trial-badge").first()).toHaveText("Growth trial: 14 days left");

  // Reloading keeps it (it's stored on the workspace, not in the page).
  await page.reload();
  await expect(page.getByTestId("chosen-plan")).toHaveText("Growth — $232/mo billed annually");
});

test("signed-in visitors skip sign-up and land on billing with the plan preselected", async ({
  page,
}) => {
  await signUpViaApi(page.request, uniqueEmail("already"));
  await pickPlanSignedIn(page);
  await expect(page.getByTestId("confirm-plan")).toContainText("Scale — $457/mo billed annually");

  // /login with a live session moves on too (after the API confirms it).
  await page.goto("/login?plan=solo&billing=monthly");
  await expect(page).toHaveURL(/\/app\/settings\/billing\?plan=solo&billing=monthly$/);

  // Without a plan, /signup goes to the app.
  await page.goto("/signup");
  await expect(page).toHaveURL(/\/app$/);
});

async function pickPlanSignedIn(page: Page) {
  await page.goto("/pricing");
  await page.getByText("Annual (2 months free)").click();
  await page.getByTestId("cta-scale").click();
  await expect(page).toHaveURL(/\/app\/settings\/billing\?plan=scale&billing=annual$/);
}

test("an expired session can still reach sign-in and sign-up", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: "ol_session", value: "expired-or-revoked", url: baseURL! }]);
  await page.goto("/signup?plan=team&billing=annual");
  // Middleware sees a cookie, the app finds it invalid, and sends the visitor to sign in.
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  // The stale cookie is cleared, so sign-up is reachable again.
  await expect
    .poll(async () => (await context.cookies()).some((c) => c.name === "ol_session"))
    .toBe(false);
  await page.goto("/signup?plan=team&billing=annual");
  await expect(page.getByTestId("plan-summary")).toContainText("Team — $99/mo billed annually");
});

test("sign-in only returns to paths inside the app (no open redirect)", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("redirect");
  await signUpViaApi(request, email);
  for (const next of [
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "/app/../help",
  ]) {
    await page.context().clearCookies();
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page, next).toHaveURL(/\/app\/contacts$/);
  }
});
