import { expect, test } from "@playwright/test";

// The 10 critical journeys (sign up, connect mailbox, import, build sequence, send,
// reply stops sequence, move deal, upgrade plan...) are added here sprint by sprint.

test("home page loads with security headers", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  await expect(page.getByRole("heading", { name: "Openline", exact: true })).toBeVisible();
});
