import { expect, test, type Page } from "@playwright/test";

// Sprint 4 journey (OL-E4 §3–4): Scout drafts a sequence step, the rep reviews it with its
// citations, edits and approves it, and the text lands in the step form — saved only when the
// rep saves. The API runs with AI_PROVIDER=fake (deterministic drafts, no network, no model).

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

test("Scout drafts a sequence step; the rep reviews, edits, approves and saves it", async ({
  page,
}) => {
  const stamp = Date.now();
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Harsh Patel");
  await page.getByLabel("Work email").fill(`scout${stamp}@openline-demo.com`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByLabel("Workspace name").fill(`Scout Demo ${stamp}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app\//);

  // A contact without a company website (no research needed) and a draft sequence.
  const contact = await api(page, "POST", "/contacts", {
    email: `jane${stamp}@example.com`,
    firstName: "Jane",
    lastName: "Doe",
    title: "VP Operations",
  });
  expect(contact.status).toBe(201);
  const seq = await api(page, "POST", "/sequences", {
    name: "Scout journey",
    steps: [{ delayDays: 0, subject: "Placeholder", body: "Placeholder" }],
  });
  expect(seq.status).toBe(201);

  // Scout settings: on, with a provider configured, usage shown.
  await page.goto("/app/settings/workspace");
  await expect(page.getByRole("heading", { name: "Scout" })).toBeVisible();
  await expect(page.getByLabel("Turn on Scout for this workspace")).toBeChecked();
  await expect(page.getByText("No AI model is set up on this server")).toHaveCount(0);

  // The inbox exists and is empty.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "You're all caught up" })).toBeVisible();

  // Draft step 1 with Scout.
  await page.goto(`/app/sequences/${seq.body.id as string}`);
  await page.getByRole("button", { name: "Draft step 1 with Scout" }).click();
  const dialog = page.getByRole("dialog", { name: "Draft step 1 with Scout" });
  await expect(dialog).toBeVisible();

  // Validation first: nothing picked.
  await dialog.getByRole("button", { name: "Draft with Scout" }).click();
  await expect(dialog.getByText("Pick a sample contact")).toBeVisible();

  await dialog.getByLabel("What is this email for?").fill("Introduce our compliance checks");
  await dialog.getByRole("searchbox", { name: "Search contacts" }).fill("jane");
  await dialog.getByRole("radio", { name: /Jane Doe/ }).check();
  await dialog.getByRole("button", { name: "Draft with Scout" }).click();

  // Review panel: clearly labelled, with each claim's source.
  await expect(dialog.getByText("Drafted by Scout — review before using")).toBeVisible();
  await expect(dialog.getByText("Sources for the claims in this draft")).toBeVisible();
  await expect(dialog.getByText("“This is a fake draft for testing.”")).toBeVisible();
  const subject = dialog.getByLabel("Subject");
  await expect(subject).toHaveValue("Quick question, {{firstName|there}}");
  const body = dialog.getByLabel("Email body");
  await body.fill(`${await body.inputValue()}\n\nP.S. Edited by the rep.`);
  await dialog.getByRole("button", { name: /Approve edits/ }).click();
  await expect(dialog).toBeHidden();

  // The text is in the step form, not saved yet.
  await expect(page.getByRole("textbox", { name: /^Subject/ })).toHaveValue(
    "Quick question, {{firstName|there}}",
  );
  await expect(page.getByRole("textbox", { name: /^Email body/ })).toHaveValue(/Edited by the rep/);
  const before = await api(page, "GET", `/sequences/${seq.body.id as string}`);
  expect(before.body.steps[0].subject).toBe("Placeholder");

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Sequence saved")).toBeVisible();
  const after = await api(page, "GET", `/sequences/${seq.body.id as string}`);
  expect(after.body.steps[0].subject).toBe("Quick question, {{firstName|there}}");
  expect(after.body.steps[0].body).toContain("P.S. Edited by the rep.");
});
