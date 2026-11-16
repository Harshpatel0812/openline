import { expect, test, type Locator, type Page } from "@playwright/test";

// Sprint 6 journeys (OL-E7): deals from a contact, the board (drag and drop, keyboard "Move to…",
// lost reason, totals, filters, list view), the deal page timeline, Settings → Pipeline and the
// Reality Check panel.

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

async function signUp(page: Page, prefix: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${prefix}${stamp}@openline-demo.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Harsh Patel");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByLabel("Workspace name").fill(`S6 ${prefix} ${stamp}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app\//);
  return { stamp, email };
}

const column = (page: Page, stage: string): Locator =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: stage, level: 2 }) });

const card = (scope: Page | Locator, name: string): Locator =>
  scope.locator("[data-deal-id]").filter({ hasText: name });

async function moveWithMenu(page: Page, deal: string, stage: string) {
  await page.getByRole("button", { name: `Move to… (deal: ${deal})` }).click();
  await page
    .getByRole("menu", { name: `Move ${deal} to` })
    .getByRole("menuitem", { name: stage })
    .click();
}

test("create a deal from a contact, move it on the board (drag and keyboard), lose it, and see the history", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { stamp } = await signUp(page, "deals");
  const contact = await api<{ id: string }>(page, "POST", "/contacts", {
    email: `ada${stamp}@acme-tools.com`,
    firstName: "Ada",
    lastName: "Lovelace",
    title: "VP Operations",
  });
  expect(contact.status).toBe(201);

  // From the contact page: "Create deal" prefilled with the contact.
  await page.goto(`/app/contacts/${contact.body.id}`);
  await page.getByRole("button", { name: "Create deal" }).click();
  const dialog = page.getByRole("dialog", { name: "New deal" });
  await expect(dialog.getByLabel("Deal name")).toHaveValue(/new deal/);
  await expect(dialog.getByText("Linked to")).toContainText("Ada Lovelace");
  await dialog.getByLabel("Deal name").fill("Acme annual plan");
  await dialog.getByLabel("Amount (optional)").fill("abc");
  await dialog.getByRole("button", { name: "Create deal" }).click();
  await expect(dialog.getByText("Enter an amount like 12500 or 12500.50")).toBeVisible();
  await dialog.getByLabel("Amount (optional)").fill("12000");
  await dialog.getByRole("button", { name: "Create deal" }).click();
  await expect(page).toHaveURL(/\/app\/deals\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Acme annual plan", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Stage", { exact: true })).toHaveValue(/.+/);

  // The sidebar has Deals (no "Pipeline — Soon").
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Deals" }).click();
  await expect(page.getByRole("heading", { name: "Deals", level: 1 })).toBeVisible();
  const discovery = column(page, "Discovery");
  const qualified = column(page, "Qualified");
  await expect(card(discovery, "Acme annual plan")).toBeVisible();
  await expect(discovery.getByRole("heading", { level: 2 })).toContainText("1");
  await expect(discovery).toContainText("$12K");
  await expect(discovery).toContainText("$1.2K weighted"); // 10 %
  await expect(page.getByText("Open pipeline").locator("..")).toContainText("$12,000.00");

  // Drag and drop to Qualified: optimistic, announced, totals follow.
  await card(discovery, "Acme annual plan").dragTo(qualified);
  await expect(card(qualified, "Acme annual plan")).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Moved Acme annual plan to Qualified." }),
  ).toBeAttached();
  await expect(qualified).toContainText("$3K weighted"); // 25 %
  await expect(discovery.getByRole("heading", { level: 2 })).toContainText("0");
  await expect(page.getByText("Weighted", { exact: true }).locator("..")).toContainText(
    "$3,000.00",
  );

  // Keyboard: open the "Move to…" menu with the keyboard and pick Proposal.
  const moveButton = page.getByRole("button", { name: "Move to… (deal: Acme annual plan)" });
  await moveButton.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Move Acme annual plan to" });
  await expect(menu.getByRole("menuitem", { name: /Discovery/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /Proposal/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card(column(page, "Proposal"), "Acme annual plan")).toBeVisible();
  await expect(moveButton).toBeFocused();

  // A failed move rolls back with a toast.
  await page.route("**/api/v1/deals/*/move", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "internal", message: "Server hiccup." }),
    }),
  );
  await moveWithMenu(page, "Acme annual plan", "Negotiation");
  await expect(
    page.getByRole("alert").filter({ hasText: "Couldn't move Acme annual plan" }),
  ).toBeVisible();
  await expect(card(column(page, "Proposal"), "Acme annual plan")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // Lost needs a reason.
  await moveWithMenu(page, "Acme annual plan", "Lost");
  const lost = page.getByRole("dialog", { name: /Mark “Acme annual plan” as lost/ });
  await lost.getByRole("button", { name: "Move to Lost" }).click();
  await expect(lost.getByText("Say why the deal was lost.")).toBeVisible();
  await lost.getByLabel("Lost reason").fill("Went with a spreadsheet");
  await lost.getByRole("button", { name: "Move to Lost" }).click();
  await expect(lost).toBeHidden();
  const lostCol = column(page, "Lost");
  await expect(lostCol.getByRole("heading", { level: 2 })).toContainText("1");
  await lostCol.getByRole("button", { name: /Show/ }).click();
  await expect(card(lostCol, "Acme annual plan")).toBeVisible();
  await expect(page.getByText("Open pipeline").locator("..")).toContainText("$0.00");

  // The deal page shows each stage change in the timeline and the stage history.
  await card(lostCol, "Acme annual plan").getByRole("link", { name: "Acme annual plan" }).click();
  const timeline = page.getByRole("list", { name: "Deal activity, newest first" });
  await expect(timeline.getByText(/Moved from Discovery to Qualified/)).toBeVisible();
  await expect(timeline.getByText(/Moved from Proposal to Lost/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Stage history" })).toContainText(
    "Created in Discovery",
  );
  await expect(page.getByText("Went with a spreadsheet").first()).toBeVisible();

  // Reopen from the stage select on the deal page.
  const stages = await api<{ id: string; name: string }[]>(page, "GET", "/pipeline/stages");
  const discoveryId = stages.body.find((s) => s.name === "Discovery")!.id;
  await page.getByLabel("Stage", { exact: true }).selectOption(discoveryId);
  await expect(page.getByRole("status").filter({ hasText: "Moved to Discovery." })).toBeAttached();
  await expect(timeline.getByText(/Moved from Lost to Discovery/)).toBeVisible();

  // Linked task from the deal page.
  await page.getByRole("button", { name: "Add task" }).click();
  const taskDialog = page.getByRole("dialog", { name: "New task" });
  await expect(taskDialog.getByText("Linked to the deal")).toContainText("Acme annual plan");
  await taskDialog.getByLabel("Title").fill("Send the security questionnaire");
  await taskDialog.getByRole("button", { name: "Create task" }).click();
  await expect(
    page
      .getByRole("list", { name: "Open tasks for Acme annual plan" })
      .getByText("Send the security questionnaire"),
  ).toBeVisible();

  // Contact page lists the deal.
  await page.goto(`/app/contacts/${contact.body.id}`);
  await expect(page.getByRole("list", { name: "Deals with Ada Lovelace" })).toContainText(
    "Acme annual plan",
  );
});

test("board filters live in the URL, and the list view sorts", async ({ page }) => {
  await signUp(page, "filters");
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
  for (const [name, amountMinor, date] of [
    ["Small deal", 100_000, soon],
    ["Big deal", 5_000_000, later],
  ] as const) {
    const r = await api(page, "POST", "/deals", { name, amountMinor, expectedCloseDate: date });
    expect(r.status).toBe(201);
  }
  await page.goto("/app/deals");
  await expect(card(page, "Small deal")).toBeVisible();
  await expect(card(page, "Big deal")).toBeVisible();

  await page.getByLabel("Closes by").fill(soon);
  await expect(page).toHaveURL(new RegExp(`to=${soon}`));
  await expect(card(page, "Big deal")).toHaveCount(0);
  await expect(card(page, "Small deal")).toBeVisible();

  await page.getByLabel("Owner").selectOption("me");
  await expect(page).toHaveURL(/owner=me/);
  await page.reload();
  await expect(page.getByLabel("Owner")).toHaveValue("me");
  await expect(page.getByLabel("Closes by")).toHaveValue(soon);
  await expect(card(page, "Small deal")).toBeVisible();

  await page.getByLabel("Stale only").click();
  await expect(page).toHaveURL(/stale=1/);
  await expect(page.getByLabel("Stale only")).toBeChecked();
  await expect(page.getByText("No deals match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/stale=1/);
  await expect(card(page, "Big deal")).toBeVisible();

  await page.getByRole("button", { name: "List" }).click();
  await expect(page).toHaveURL(/view=list/);
  const table = page.getByRole("table", { name: "Deals" });
  await table.getByRole("button", { name: /Amount/ }).click();
  await expect(table.getByRole("row").nth(1)).toContainText("Small deal");
  await table.getByRole("button", { name: /Amount/ }).click();
  await expect(table.getByRole("columnheader", { name: /Amount/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(table.getByRole("row").nth(1)).toContainText("Big deal");
});

test("Settings → Pipeline: rename a stage, set criteria, and see validation", async ({ page }) => {
  await signUp(page, "stages");
  await page.goto("/app/settings/pipeline");
  await expect(page.getByRole("heading", { name: "Pipeline", level: 1 })).toBeVisible();
  const first = page.getByRole("group", { name: /^Stage 1:/ });
  const second = page.getByRole("group", { name: /^Stage 2:/ });

  // Duplicate names are refused next to the field.
  await second.getByLabel("Name").fill("Discovery");
  await page.getByRole("button", { name: "Save pipeline" }).click();
  await expect(second.getByText("Stage names must be unique")).toBeVisible();
  await second.getByLabel("Name").fill("Qualified");

  await first.getByLabel("Name").fill("Intro call");
  await first.getByLabel("Probability %").fill("15");
  await first.getByRole("button", { name: /Add criterion/ }).click();
  await first
    .getByRole("textbox", { name: /^Criterion \d$/ })
    .last()
    .fill("Budget owner joined a call");
  await first.getByRole("combobox", { name: "Evidence" }).last().selectOption("budget_discussed");
  // Reorder with buttons: Qualified moves up to first place, then back.
  await page.getByRole("button", { name: "Move Qualified up" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Qualified moved to position 1" }),
  ).toBeAttached();
  await page.getByRole("button", { name: "Move Qualified down" }).click();
  await page.getByRole("button", { name: "Save pipeline" }).click();
  await expect(page.getByText("Pipeline saved")).toBeVisible();

  const stages = await api<
    { name: string; probability: number; entryCriteria: { label: string; evidence: string }[] }[]
  >(page, "GET", "/pipeline/stages");
  expect(stages.body[0]).toMatchObject({ name: "Intro call", probability: 15 });
  expect(stages.body[0]!.entryCriteria).toContainEqual({
    label: "Budget owner joined a call",
    evidence: "budget_discussed",
  });

  await page.goto("/app/deals");
  await expect(page.getByRole("heading", { name: /Intro call/, level: 2 })).toBeVisible();

  // Workspace currency.
  await page.goto("/app/settings/workspace");
  await page.getByLabel("Currency").selectOption("EUR");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Workspace settings saved")).toBeVisible();
});

test("Reality Check panel: check now, evidence quotes, Not right, and accepting Scout's suggestion", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signUp(page, "reality");
  const stages = await api<{ id: string; name: string }[]>(page, "GET", "/pipeline/stages");
  const byName = (n: string) => stages.body.find((s) => s.name === n)!.id;
  const yesterday = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const created = await api<{ id: string }>(page, "POST", "/deals", {
    name: "Globex rollout",
    stageId: byName("Proposal"),
    nextStep: "Send the order form",
    nextStepDate: yesterday,
  });
  expect(created.status).toBe(201);
  const id = created.body.id;

  // Real endpoint: with no emails, only the date checks run (no AI), and they flag the overdue
  // next step.
  await page.goto(`/app/deals/${id}`);
  const panel = page.getByRole("region", { name: "Reality Check" });
  await panel.getByRole("button", { name: "Check now" }).click();
  await expect(panel.getByText(/Last checked/)).toBeVisible();
  await expect(panel.getByText("Only the date checks ran", { exact: true })).toBeVisible();
  await expect(panel.getByText(/High severity|Medium severity|Low severity/).first()).toBeVisible();

  // Model evidence, a dismissable flag and a suggestion (mocked: the fake model's output is
  // deterministic but email-free here).
  const ranAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const check = {
    dealId: id,
    ranAt,
    model: "small",
    deterministicOnly: false,
    runsLeftToday: 7,
    evidenceStageId: byName("Discovery"),
    evidence: {
      decision_maker_engaged: { present: "unclear" },
      budget_discussed: { present: "no" },
      need_confirmed: {
        present: "yes",
        quote: "we really need to cut the time spent on manual follow-ups",
        messageId: "00000000-0000-4000-8000-000000000001",
      },
      proposal_sent: { present: "no" },
    },
    flags: [
      {
        id: "a1b2c3d4e5f60718",
        code: "stage_ahead_of_evidence",
        severity: "high",
        message: "Stage says Proposal, evidence says Discovery",
      },
      {
        id: "0f1e2d3c4b5a6978",
        code: "criterion_missing",
        severity: "medium",
        message: "No sign that budget was discussed",
        criterion: {
          stageId: byName("Qualified"),
          stageName: "Qualified",
          label: "Budget discussed",
          evidence: "budget_discussed",
        },
      },
    ],
    suggestion: {
      actionId: "00000000-0000-4000-8000-000000000002",
      toStageId: byName("Discovery"),
      toStageName: "Discovery",
      reason: "No proposal or budget appears in the emails yet.",
      status: "proposed",
    },
  };
  let dismissedWith: unknown = null;
  let current: typeof check & { flags: unknown[] } = check;
  await page.route(`**/api/v1/deals/${id}/reality-check`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { check: current } })
      : route.fallback(),
  );
  await page.route(`**/api/v1/deals/${id}/reality-check/flags/*/dismiss`, async (route) => {
    dismissedWith = route.request().postDataJSON();
    current = {
      ...check,
      flags: [
        check.flags[0],
        {
          ...check.flags[1],
          dismissed: {
            reason: "Discussed on a call",
            at: new Date().toISOString(),
            by: { id: "x", name: "Harsh Patel" },
          },
        },
      ],
    };
    await route.fulfill({ json: current });
  });
  await page.route(`**/api/v1/deals/${id}/reality-check/suggestion/accept`, async (route) => {
    // Accept for real by moving the deal, then answer with the contract's shape.
    const moved = await api(page, "POST", `/deals/${id}/move`, { stageId: byName("Discovery") });
    current = { ...current, suggestion: { ...check.suggestion, status: "executed" } };
    await route.fulfill({ json: { deal: moved.body, check: current } });
  });
  await page.reload();

  await expect(panel.getByText(/Last checked 2 hr/)).toBeVisible();
  await expect(
    panel.getByText("Suggested by Scout — nothing moves until you accept"),
  ).toBeVisible();
  await expect(panel.getByText("Move to Discovery?")).toBeVisible();
  await expect(panel.getByText("High severity")).toBeVisible();
  await expect(panel.getByText("Stage says Proposal, evidence says Discovery")).toBeVisible();
  await expect(panel.getByText("The evidence supports Discovery.")).toBeVisible();
  const need = panel.getByRole("listitem").filter({ hasText: "Need confirmed" });
  await expect(need.getByText("Yes", { exact: true })).toBeVisible();
  await expect(need.getByText(/manual follow-ups/)).toBeVisible();
  await expect(need.getByRole("link", { name: "View the email" })).toHaveAttribute(
    "href",
    "#timeline-msg-00000000-0000-4000-8000-000000000001",
  );
  await expect(
    panel
      .getByRole("listitem")
      .filter({ hasText: "Budget discussed" })
      .getByText("No", { exact: true }),
  ).toBeVisible();

  // "Not right" needs a reason.
  await panel.getByRole("button", { name: "Not right: No sign that budget was discussed" }).click();
  const notRight = page.getByRole("dialog", { name: "Not right?" });
  await notRight.getByRole("button", { name: "Hide this flag" }).click();
  await expect(notRight.getByText("Say why")).toBeVisible();
  await notRight.getByLabel("Why isn't it right?").fill("Discussed on a call");
  await notRight.getByRole("button", { name: "Hide this flag" }).click();
  await expect(notRight).toBeHidden();
  expect(dismissedWith).toEqual({ reason: "Discussed on a call" });
  await expect(panel.getByText("Flags (1)")).toBeVisible();
  await expect(panel.getByText("Marked not right (1)")).toBeVisible();

  // Nothing moved until Accept.
  await expect(page.getByLabel("Stage", { exact: true })).toHaveValue(byName("Proposal"));
  await panel.getByRole("button", { name: "Accept — move to Discovery" }).click();
  await expect(page.getByLabel("Stage", { exact: true })).toHaveValue(byName("Discovery"));
  await expect(panel.getByText("Move to Discovery?")).toHaveCount(0);
});
