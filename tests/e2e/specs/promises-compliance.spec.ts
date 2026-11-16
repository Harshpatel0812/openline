import { expect, test, type Page } from "@playwright/test";

// Sprint 5 journeys (OL-E6): tasks, Compliance Copilot on the contact page and in the enroll
// dialog, and accepting a Promise Keeper suggestion. All mail goes to the local sink.

const SINK = "http://127.0.0.1:2580/messages";
type SinkMessage = { to: string[]; raw: string };

const decodeQuotedPrintable = (s: string) =>
  s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

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

async function signUp(page: Page, prefix: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${prefix}${stamp}@openline-demo.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Harsh Patel");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByLabel("Workspace name").fill(`S5 ${prefix} ${stamp}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app\//);
  return { stamp, email };
}

/** A sequence that may send at any hour, so "Allowed" doesn't depend on when the test runs. */
const ALWAYS_OPEN = { days: [1, 2, 3, 4, 5, 6, 7], startHour: 0, endHour: 24 };

test("create a task, see it overdue, and complete it", async ({ page }) => {
  await signUp(page, "tasks");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  // Validation first: no title.
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog.getByText("Give the task a title")).toBeVisible();

  await dialog.getByLabel("Title").fill("Send the pricing sheet");
  const yesterday = new Date(Date.now() - 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  await dialog
    .getByLabel("Due date")
    .fill(
      `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`,
    );
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();

  // It's overdue: red badge in the list and a count in the sidebar.
  await page.getByRole("tab", { name: /Overdue/ }).click();
  const list = page.getByRole("list", { name: "Overdue" });
  await expect(list.getByText("Send the pricing sheet")).toBeVisible();
  await expect(list.getByText("Overdue")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Tasks.*overdue/ }),
  ).toBeVisible();

  // Today: once the task is visible, no card is still "Loading"; empty cards say so. The counts
  // are held back on purpose: the cards must not wait for them once their tasks have arrived.
  let releaseCounts = () => {};
  const countsHeld = new Promise<void>((resolve) => (releaseCounts = resolve));
  await page.route("**/api/v1/tasks/counts", async (route) => {
    await countsHeld;
    await route.continue().catch(() => undefined);
  });
  await page.goto("/app");
  const overdueCard = page.getByRole("region", { name: "Overdue" });
  await expect(overdueCard.getByText("Send the pricing sheet")).toBeVisible();
  await expect(overdueCard).toContainText("1");
  const tasksSection = page.getByRole("region", { name: "Your tasks" });
  await expect(tasksSection.getByText(/Loading/)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Due today" })).toContainText("Nothing due today.");
  await expect(page.getByRole("region", { name: "Next 7 days" })).toContainText(
    "Nothing in the next 7 days.",
  );
  releaseCounts();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Tasks/ }).click();
  await page.getByRole("tab", { name: /Overdue/ }).click();

  await list.getByRole("button", { name: "Complete — Send the pricing sheet" }).click();
  await expect(page.getByRole("heading", { name: "Nothing overdue" })).toBeVisible();
  await page.getByRole("tab", { name: "Done" }).click();
  await expect(
    page.getByRole("list", { name: "Done" }).getByText("Send the pricing sheet"),
  ).toBeVisible();

  // Today shows the task cards.
  await page.goto("/app");
  await expect(page.getByRole("region", { name: "Overdue" })).toContainText("0");
});

test("Compliance Copilot: Blocked for a suppressed contact, Allowed for a normal one, and the enroll preview lists the blocked contact", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { stamp, email } = await signUp(page, "copilot");

  // Verify the email (needed to enroll), add a postal address and an SMTP mailbox.
  let raw = "";
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(SINK)).json()) as SinkMessage[];
        raw = all.find((m) => m.to.includes(email) && /verify/i.test(m.raw))?.raw ?? "";
        return raw.length > 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const link = decodeQuotedPrintable(raw).match(
    /https?:\/\/[^\s"<>]+\/verify-email\?token=[A-Za-z0-9_-]+/,
  )?.[0];
  expect(link).toBeTruthy();
  await page.goto(link!);
  await expect(page.getByText(/verified/i).first()).toBeVisible();

  expect(
    (await api(page, "PATCH", "/workspace", { mailingAddress: "30 Hudson St, Jersey City, NJ" }))
      .status,
  ).toBe(200);
  const mailbox = await api(page, "POST", "/mailboxes/smtp", {
    email,
    displayName: "Harsh",
    host: "127.0.0.1",
    port: 2525,
    secure: false,
    username: "harsh",
    password: "app-password",
    dailyCap: 50,
  });
  expect(mailbox.status, JSON.stringify(mailbox.body)).toBe(201);

  await api(page, "POST", "/suppressions", { value: `sam${stamp}@rival.io`, reason: "competitor" });
  const sam = await api(page, "POST", "/contacts", {
    email: `sam${stamp}@rival.io`,
    firstName: "Sam",
    lastName: "Rival",
    country: "US",
  });
  const jane = await api(page, "POST", "/contacts", {
    email: `jane${stamp}@acme-tools.com`,
    firstName: "Jane",
    lastName: "Doe",
    country: "US",
  });
  expect(sam.status).toBe(201);
  expect(jane.status).toBe(201);
  const seq = await api(page, "POST", "/sequences", {
    name: "Always open",
    sendWindow: ALWAYS_OPEN,
    steps: [{ delayDays: 0, subject: "Hi {{firstName|there}}", body: "Quick question." }],
  });
  expect(seq.status).toBe(201);
  expect(
    (await api(page, "POST", `/sequences/${seq.body.id as string}/status`, { status: "active" }))
      .status,
  ).toBe(200);

  // Suppressed contact: Blocked, with the failing check and its citation.
  await page.goto(`/app/contacts/${sam.body.id as string}`);
  const panel = page.getByRole("region", { name: "Can I email them?" });
  await expect(panel.getByTestId("compliance-decision")).toContainText("Blocked");
  await expect(panel.getByText("This address is on your suppression list.")).toBeVisible();
  await expect(panel.getByText("This is not legal advice.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Download compliance record" })).toBeVisible();

  // Normal contact, checked against the always-open sequence: Allowed.
  await page.goto(`/app/contacts/${jane.body.id as string}`);
  await panel
    .getByLabel("Business hours to check against")
    .selectOption({ label: "Sequence: Always open" });
  await expect(panel.getByTestId("compliance-decision")).toContainText("Allowed");

  // Enroll dialog: the preview lists Sam as blocked before anything is enrolled.
  await page.goto("/app/contacts");
  await page.getByLabel("Select Sam Rival").check();
  await page.getByLabel("Select Jane Doe").check();
  await page.getByRole("button", { name: "Add to sequence" }).click();
  const dialog = page.getByRole("dialog", { name: "Add to sequence" });
  await expect(dialog.getByText("Won't be added (1)")).toBeVisible();
  await expect(dialog.getByText(/Sam Rival.*Suppression list/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add 1 contact" })).toBeEnabled();
  const before = await api(page, "GET", `/sequences/${seq.body.id as string}/enrollments`);
  expect(before.body.items).toHaveLength(0);
  await dialog.getByRole("button", { name: "Add 1 contact" }).click();
  await expect(dialog.getByText("1 added")).toBeVisible();
});

test("accept a Promise Keeper suggestion (mocked proposals)", async ({ page }) => {
  const { stamp } = await signUp(page, "promise");
  const contact = await api(page, "POST", "/contacts", {
    email: `dana${stamp}@brightwell.com`,
    firstName: "Dana",
    lastName: "Lee",
  });
  expect(contact.status).toBe(201);
  const contactId = contact.body.id as string;
  const now = new Date();
  const due = new Date(now.getTime() + 3 * 86_400_000);
  due.setHours(17, 0, 0, 0);
  const proposal = {
    id: "0f0f0f0f-1111-4222-8333-444444444444",
    kind: "promise_task",
    status: "proposed",
    userId: "u",
    contactId,
    messageId: "0f0f0f0f-1111-4222-8333-555555555555",
    type: "our_promise",
    who: "us",
    direction: "outbound",
    what: "I'll send the pricing sheet by Friday",
    whenPhrase: "by Friday",
    title: "Send Dana the pricing sheet",
    taskKind: "send_promised",
    dueAt: due.toISOString(),
    dueDateMissing: false,
    confidence: 0.9,
    source: "rule",
    createdAt: now.toISOString(),
    decidedAt: null,
    taskId: null,
  };
  // A legacy pause proposal must never be shown.
  const pause = {
    ...proposal,
    id: "0f0f0f0f-1111-4222-8333-666666666666",
    kind: "pause_enrollments",
    what: "Try me after budget in March",
    title: "Pause until March",
  };
  let accepted: unknown = null;
  await page.route("**/api/v1/promises?**", (route) =>
    route.fulfill({ json: accepted ? [] : [proposal, pause] }),
  );
  await page.route(`**/api/v1/promises/${proposal.id}/accept`, async (route) => {
    accepted = route.request().postDataJSON();
    const body = accepted as { title?: string };
    const task = await api(page, "POST", "/tasks", {
      title: body.title ?? proposal.title,
      contactId,
      kind: "send_promised",
      dueAt: proposal.dueAt,
    });
    await route.fulfill({
      json: { promise: { ...proposal, status: "accepted" }, task: task.body },
    });
  });

  await page.goto(`/app/contacts/${contactId}`);
  const panel = page.getByRole("region", { name: "Promises Scout found" });
  await expect(
    panel.getByText("Suggested by Scout — nothing happens until you accept"),
  ).toBeVisible();
  await expect(panel.getByText("“I'll send the pricing sheet by Friday”")).toBeVisible();
  await expect(panel.getByText("Try me after budget in March")).toHaveCount(0);

  await panel
    .getByRole("button", { name: "Edit before accepting — Send Dana the pricing sheet" })
    .click();
  await panel.getByLabel("Task title").fill("Send Dana the pricing sheet and case study");
  await panel.getByRole("button", { name: "Accept with changes" }).click();
  await expect(
    page.getByText(/Task created: Send Dana the pricing sheet and case study/).first(),
  ).toBeVisible();
  expect(accepted).toEqual({ title: "Send Dana the pricing sheet and case study" });

  // The task is on the contact page.
  await expect(
    page
      .getByRole("list", { name: "Open tasks for Dana Lee" })
      .getByText("Send Dana the pricing sheet and case study"),
  ).toBeVisible();
});
