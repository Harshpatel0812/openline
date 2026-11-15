import { expect, test, type Page } from "@playwright/test";

// Public website (epic OL-E5): every page renders, navigation works, the pricing toggle and the
// contact form behave. The contact endpoint is mocked with page.route, so no email is sent.

const PUBLIC_PAGES = [
  "/",
  "/features",
  "/pricing",
  "/compare/openline-vs-apollo",
  "/compare/openline-vs-outreach",
  "/compare/openline-vs-hubspot",
  "/help",
  "/help/first-30-minutes",
  "/help/roles-and-invites",
  "/help/import-contacts-csv",
  "/help/connect-a-mailbox",
  "/help/build-your-first-sequence",
  "/help/replies-and-inbox",
  "/help/scout",
  "/help/compliance-basics",
  "/help/deliverability-basics",
  "/blog",
  "/blog/why-cold-emails-land-in-spam",
  "/blog/how-many-follow-ups-is-too-many",
  "/blog/can-spam-vs-casl-vs-gdpr",
  "/contact",
  "/security",
  "/privacy",
  "/terms",
];

test("every public page returns 200 with one h1, a canonical URL and no script errors", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // A CSP violation (e.g. an inline script without the nonce) is reported as a console error.
    if (m.type() === "error" && /Content Security Policy/i.test(m.text())) errors.push(m.text());
  });
  for (const path of PUBLIC_PAGES) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator("h1"), path).toHaveCount(1);
    await expect(page.locator("h1"), path).toBeVisible();
    await expect(page.locator('link[rel="canonical"]'), path).toHaveAttribute(
      "href",
      /^https?:\/\//,
    );
    await expect(page.locator('meta[property="og:title"]'), path).toHaveAttribute("content", /.+/);
  }
  expect(errors).toEqual([]);
});

test("legal pages carry the draft notice; the footer links to the cookie section", async ({
  page,
}) => {
  for (const path of ["/privacy", "/terms"]) {
    await page.goto(path);
    await expect(page.getByRole("note")).toHaveText("Draft — under legal review");
  }
  await page.goto("/");
  await page.getByRole("link", { name: "We only use essential cookies" }).click();
  await expect(page).toHaveURL(/\/privacy#cookies$/);
  await expect(page.locator("#cookies")).toBeVisible();
});

test("unknown pages show a 404 with a way back", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("We couldn't find that page");
  await page.getByRole("link", { name: "Back to the home page" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("header navigation reaches every section", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main", exact: true });
  for (const [label, path] of [
    ["Features", "/features"],
    ["Pricing", "/pricing"],
    ["Help", "/help"],
    ["Blog", "/blog"],
    ["Contact", "/contact"],
  ] as const) {
    await nav.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  }
  await page.getByRole("banner").getByRole("link", { name: "Start free trial" }).click();
  await expect(page).toHaveURL(/\/signup$/);
});

test("mobile menu opens, navigates and closes with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Open menu" });
  await toggle.click();
  const menu = page.getByRole("navigation", { name: "Main mobile" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await menu.getByRole("link", { name: "Pricing" }).click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByRole("navigation", { name: "Main mobile" })).toBeHidden();
  // Nothing scrolls sideways at 375 px.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("pricing toggle switches between monthly and annual prices", async ({ page }) => {
  await page.goto("/pricing");
  const team = page.getByTestId("price-team");
  await expect(team).toHaveText("$119");
  await expect(page.getByTestId("price-solo")).toHaveText("$39");

  await page.getByText("Annual (2 months free)").click();
  await expect(team).toHaveText("$99");
  await expect(page.getByTestId("price-solo")).toHaveText("$32");
  await expect(page.getByTestId("price-scale")).toHaveText("$457");

  await page.getByText("Monthly", { exact: true }).click();
  await expect(team).toHaveText("$119");
});

test("pricing FAQ opens and the mobile plan tabs switch plans", async ({ page }) => {
  await page.goto("/pricing");
  const question = page.getByText("What happens when we hit a limit?");
  await question.click();
  await expect(page.getByText(/sending pauses until you.re back under the limit/)).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  const tabs = page.getByRole("tablist", { name: "Choose a plan to compare" });
  await expect(tabs.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Scale" }).click();
  await expect(tabs.getByRole("tab", { name: "Scale" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel").getByText("200,000")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: "Growth" })).toBeFocused();
});

async function fillContactForm(page: Page) {
  await page.getByLabel("Name").fill("Dana Whitfield");
  await page.getByLabel("Work email").fill("dana@brightwell.example");
  await page.getByLabel("Company").fill("Brightwell Freight");
  await page.getByLabel("Team size").selectOption("6-15");
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("We'd like a demo for our five-person sales team.");
}

test("contact form shows field errors, then sends and shows success", async ({ page }) => {
  let posted: unknown = null;
  await page.route("**/api/v1/public/contact", async (route) => {
    posted = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.goto("/contact");

  // The honeypot exists but is hidden from people.
  await expect(page.locator('input[name="website"]')).toBeAttached();
  await expect(page.locator('input[name="website"]')).not.toBeInViewport();

  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Tell us your name")).toBeVisible();
  await expect(page.getByText("Enter a valid email address")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Name")).toBeFocused();
  expect(posted).toBeNull();

  await fillContactForm(page);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Thanks — your message is on its way")).toBeVisible();
  expect(posted).toMatchObject({
    name: "Dana Whitfield",
    email: "dana@brightwell.example",
    company: "Brightwell Freight",
    teamSize: "6-15",
  });
});

test("contact form shows API validation errors next to the field, and rate limiting", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/v1/public/contact", async (route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          code: "validation_error",
          message: "Check the highlighted fields.",
          details: [{ path: ["email"], message: "Use your work email address" }],
        }),
      });
    } else {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ code: "rate_limited", message: "Too many requests" }),
      });
    }
  });
  await page.goto("/contact");
  await fillContactForm(page);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Use your work email address")).toBeVisible();
  await expect(page.getByLabel("Work email")).toHaveAttribute("aria-invalid", "true");

  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Message not sent" })).toContainText(
    "Please wait a few minutes",
  );
});

test("help search filters articles by title", async ({ page }) => {
  await page.goto("/help");
  await page.getByLabel("Search help articles").fill("unsubscribe");
  await expect(page.getByRole("search").getByRole("status")).toHaveText(/article/);
  await page.getByLabel("Search help articles").fill("csv");
  const result = page
    .getByRole("search")
    .getByRole("link", { name: /Importing contacts from a CSV/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Importing contacts from a CSV");
});

test("robots.txt and sitemap.xml are served", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Disallow: /app");
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain("/pricing</loc>");
});
