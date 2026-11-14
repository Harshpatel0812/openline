import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Critical journeys for Sprint 1–2 (OL-E1 foundation, OL-E2 contacts), run against the built
// API (in-memory Postgres) and web app. Locators follow the real labels in apps/web/src.

const PASSWORD = "correct horse battery staple";
let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}-${Date.now()}@example.com`;
}

/** Signs up through the UI and waits for the contacts page. */
async function signUp(
  page: Page,
  opts: { name?: string; email?: string; workspaceName?: string } = {},
) {
  const name = opts.name ?? "Harper Lane";
  const email = opts.email ?? uniqueEmail("owner");
  const workspaceName = opts.workspaceName ?? `Acme ${Date.now()}`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Workspace name").fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app\/contacts$/);
  return { name, email, workspaceName };
}

/** Creates an account through the API only (its cookie stays in `request`, not the page). */
async function signUpViaApi(request: APIRequestContext, email: string) {
  const res = await request.post("/api/v1/auth/signup", {
    headers: { "x-openline-csrf": "1" },
    data: { name: "Api User", email, password: PASSWORD, workspaceName: "Api Co" },
  });
  expect(res.status()).toBe(201);
}

/** The value shown under a stat label (<dt>label</dt><dd>value</dd>). */
function stat(page: Page, label: string) {
  return page
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

test("sign up, add a contact, open it and edit the title", async ({ page }) => {
  const { workspaceName } = await signUp(page);

  // App shell shows the workspace; contacts are empty.
  await expect(page.getByRole("banner").getByText(workspaceName)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No contacts yet" })).toBeVisible();

  await page.getByRole("button", { name: "Add contact" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add contact" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Email", exact: true }).fill("Jane.Doe@Acme-Tools.com");
  await dialog.getByLabel("First name").fill("Jane");
  await dialog.getByLabel("Last name").fill("Doe");
  await dialog.getByLabel("Job title").fill("VP Sales");
  await dialog.getByRole("button", { name: "Add contact" }).click();
  await expect(dialog).toBeHidden();

  const table = page.getByRole("table", { name: "Contacts" });
  const row = table.getByRole("row", { name: /Jane Doe/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("jane.doe@acme-tools.com");
  await expect(row).toContainText("Acme Tools");
  await expect(page.getByText("1 contact", { exact: true })).toBeVisible();

  await table.getByRole("link", { name: "Jane Doe" }).click();
  await expect(page).toHaveURL(/\/app\/contacts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Jane Doe", level: 1 })).toBeVisible();

  const save = page.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();
  const title = page.getByLabel("Job title");
  await expect(title).toHaveValue("VP Sales");
  await title.fill("Head of Revenue");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText("Contact saved")).toBeVisible();
  await expect(save).toBeDisabled();

  // Persisted: a reload shows the new title.
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue("Head of Revenue");
  await expect(page.getByText("Head of Revenue at Acme Tools")).toBeVisible();
});

test("import a CSV: preview counts, confirm lawful basis, import, see contacts", async ({
  page,
}) => {
  await signUp(page);
  await page.getByRole("link", { name: "Import CSV" }).click();
  await expect(page.getByRole("heading", { name: "Import contacts" })).toBeVisible();

  const csv =
    "﻿Email,First Name,Last Name,Company\r\n" +
    "ann@alpha.io,Ann,Lee,Alpha\r\n" +
    'ben@beta.io,Ben,Ray,"Beta, Inc."\r\n' +
    "cy@gamma.io,Cy,Ito,Gamma\r\n" +
    "ANN@alpha.io,Dup,Row,Alpha\r\n" +
    "not-an-email,Bad,Row,\r\n";
  await page.getByLabel("CSV file").setInputFiles({
    name: "contacts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await page.getByRole("button", { name: "Preview import" }).click();

  await expect(page.getByRole("heading", { name: "2. Review" })).toBeVisible();
  await expect(page.getByText("contacts.csv · comma-separated")).toBeVisible();
  await expect(stat(page, "Rows read")).toHaveText("5");
  await expect(stat(page, "New")).toHaveText("3");
  await expect(stat(page, "Duplicates")).toHaveText("0");
  await expect(stat(page, "Invalid")).toHaveText("2");
  await expect(page.getByText("Duplicate of row 1")).toBeVisible();
  const mapping = page.getByRole("table", { name: "Detected column mapping" });
  await expect(mapping.getByRole("row", { name: /Company\s+Company name/ })).toBeVisible();

  // Nothing is saved until the lawful-basis box is ticked.
  const importButton = page.getByRole("button", { name: "Import 3 contacts" });
  const lawful = page.getByLabel(/I confirm I have a lawful basis/);
  await expect(lawful).not.toBeChecked();
  await lawful.check();
  await importButton.click();

  await expect(page.getByRole("heading", { name: "3. Import complete" })).toBeVisible();
  await expect(page.getByText("Your contacts have been imported.")).toBeVisible();
  await expect(stat(page, "Created")).toHaveText("3");
  await expect(stat(page, "Skipped")).toHaveText("0");
  await expect(stat(page, "Invalid")).toHaveText("2");

  await page.getByRole("link", { name: "View contacts" }).click();
  await expect(page).toHaveURL(/\/app\/contacts$/);
  const table = page.getByRole("table", { name: "Contacts" });
  for (const name of ["Ann Lee", "Ben Ray", "Cy Ito"]) {
    await expect(table.getByRole("link", { name })).toBeVisible();
  }
  await expect(table.getByRole("row", { name: /Ben Ray/ })).toContainText("Beta, Inc.");
  await expect(page.getByText("3 contacts", { exact: true })).toBeVisible();
});

test("owner invites a teammate, who opens the link in a new browser and joins", async ({
  page,
  browser,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { workspaceName } = await signUp(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Team" }).click();
  await expect(page.getByRole("heading", { name: "Team", level: 1 })).toBeVisible();

  const teammate = uniqueEmail("teammate");
  await page.getByRole("button", { name: "Invite teammate" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Invite teammate" });
  await dialog.getByRole("textbox", { name: "Email", exact: true }).fill(teammate);
  await dialog.getByLabel("Role").selectOption("manager");
  await dialog.getByRole("button", { name: "Create invite" }).click();

  const created = page.getByRole("dialog", { name: "Invite created" });
  await expect(created).toBeVisible();
  const linkInput = created.getByLabel(`Invite link for ${teammate}`);
  const shownUrl = await linkInput.inputValue();
  expect(shownUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await created.getByRole("button", { name: "Copy" }).click();
  await expect(created.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(shownUrl);
  await created.getByRole("button", { name: "Done" }).click();
  await expect(
    page.getByRole("table", { name: "Pending invites" }).getByRole("row", { name: /teammate/ }),
  ).toBeVisible();

  // The teammate opens the link in a separate browser (no shared cookies).
  const other = await browser.newContext();
  try {
    const invitee = await other.newPage();
    await invitee.goto(new URL(copied).pathname);
    await expect(invitee.getByRole("heading", { name: `Join ${workspaceName}` })).toBeVisible();
    await expect(invitee.getByRole("textbox", { name: "Email", exact: true })).toHaveValue(
      teammate,
    );
    await expect(invitee.getByRole("textbox", { name: "Email", exact: true })).toBeDisabled();
    await invitee.getByLabel("Your name").fill("Taylor Teammate");
    await invitee.getByLabel("Password").fill(PASSWORD);
    await invitee.getByRole("button", { name: "Create account and join" }).click();

    await expect(invitee).toHaveURL(/\/app\/contacts$/);
    await expect(invitee.getByRole("banner").getByText(workspaceName)).toBeVisible();
    // Managers do not see team management.
    await invitee
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Team" })
      .click();
    await expect(invitee.getByRole("cell", { name: teammate })).toBeVisible();
    await expect(invitee.getByRole("button", { name: "Invite teammate" })).toHaveCount(0);
  } finally {
    await other.close();
  }

  // The owner now sees the teammate as a member and no pending invite.
  await page.reload();
  await expect(
    page.getByRole("table", { name: "Workspace members" }).getByRole("cell", { name: teammate }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "No pending invites" })).toBeVisible();
});

test("sign out, then the app redirects to the login page", async ({ page }) => {
  const { name } = await signUp(page);
  await page.getByRole("button", { name: `Account menu for ${name}` }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Openline" })).toBeVisible();

  await page.goto("/app/contacts");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fcontacts$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a wrong password and an unknown email show the same generic error", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("login");
  await signUpViaApi(request, email);
  const generic = "That email and password don't match. Check them and try again.";

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("definitely the wrong one");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: generic })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Email").fill(uniqueEmail("nobody"));
  const unknown = page.waitForResponse((r) => r.url().endsWith("/api/v1/auth/login"));
  await page.getByRole("button", { name: "Sign in" }).click();
  expect((await unknown).status()).toBe(401);
  await expect(page.getByRole("alert").filter({ hasText: generic })).toBeVisible();

  // And the right password still works.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/contacts$/);
});
