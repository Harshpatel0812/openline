import { expect, test, type Page } from "@playwright/test";

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

test("shots", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const stamp = `${Date.now()}`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Harsh Patel");
  await page.getByLabel("Work email").fill(`shots${stamp}@openline-demo.com`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByLabel("Workspace name").fill(`Northwind Sales`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app\//);
  await page.evaluate(() => sessionStorage.setItem("ol:verify-banner-dismissed", "x"));
  const stages = (await api<{ id: string; name: string }[]>(page, "GET", "/pipeline/stages")).body;
  const sid = (n: string) => stages.find((s) => s.name === n)!.id;
  const d = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const contacts: Record<string, string> = {};
  for (const [email, first, last, title] of [
    ["maria@globex-corp.com", "Maria", "Chen", "Head of Sales Ops"],
    ["sam@initech.io", "Sam", "Okafor", "CRO"],
    ["lena@umbrella-labs.com", "Lena", "Fischer", "VP Revenue"],
  ]) {
    const c = await api<{ id: string }>(page, "POST", "/contacts", { email, firstName: first, lastName: last, title });
    contacts[first!] = c.body.id;
  }
  const deals: [string, string, number | null, string | null, string | null, string | null, string][] = [
    ["Globex — 25 seats", "Discovery", 1_800_000, d(40), "Intro call with ops", d(3), "Maria"],
    ["Initech pilot", "Discovery", 650_000, d(70), null, null, "Sam"],
    ["Umbrella Labs annual", "Qualified", 4_200_000, d(20), "Security review", d(-2), "Lena"],
    ["Hooli expansion", "Proposal", 9_600_000, d(12), null, null, "Sam"],
    ["Stark Industries", "Negotiation", 15_000_000, d(6), "Legal redlines", d(2), "Maria"],
    ["Wayne Ent. renewal", "Won", 3_000_000, d(-5), null, null, "Lena"],
  ];
  let globex = "";
  for (const [name, stage, amountMinor, close, ns, nsd, who] of deals) {
    const firstOpen = stage === "Won" ? "Negotiation" : stage;
    const r = await api<{ id: string }>(page, "POST", "/deals", {
      name, stageId: sid(firstOpen), amountMinor, expectedCloseDate: close, nextStep: ns, nextStepDate: nsd, primaryContactId: contacts[who],
    });
    if (stage === "Won") await api(page, "POST", `/deals/${r.body.id}/move`, { stageId: sid("Won") });
    if (name === "Hooli expansion") globex = r.body.id;
  }
  await page.goto("/app/deals");
  await expect(page.locator("[data-deal-id]").first()).toBeVisible();
  await page.screenshot({ path: "/home/claude/shots/s6-board-desktop.png", fullPage: true });

  // Deal page with a Reality Check (evidence mocked: no emails in this workspace).
  const check = {
    dealId: globex, ranAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), model: "small",
    deterministicOnly: false, runsLeftToday: 8, evidenceStageId: sid("Qualified"),
    evidence: {
      decision_maker_engaged: { present: "yes", quote: "Looping in our CRO, Sam, who signs off on tools over $50k.", messageId: "m1" },
      budget_discussed: { present: "yes", quote: "We have roughly $100k set aside for this in Q1.", messageId: "m2" },
      need_confirmed: { present: "yes", quote: "Our reps lose a day a week to manual follow-ups.", messageId: "m1" },
      timeline_discussed: { present: "unclear" },
      proposal_sent: { present: "no" },
      verbal_yes: { present: "no" },
    },
    flags: [
      { id: "a1b2c3d4e5f60718", code: "stage_ahead_of_evidence", severity: "high", message: "Stage says Proposal, evidence says Qualified" },
      { id: "0f1e2d3c4b5a6978", code: "criterion_missing", severity: "medium", message: "No sign a proposal was sent", criterion: { stageId: sid("Proposal"), stageName: "Proposal", label: "Proposal sent", evidence: "proposal_sent" } },
      { id: "1111222233334444", code: "no_next_step", severity: "low", message: "No next step on a deal past Discovery" },
    ],
    suggestion: { actionId: "x", toStageId: sid("Qualified"), toStageName: "Qualified", reason: "The emails show budget and a decision maker, but no proposal yet.", status: "proposed" },
  };
  await page.route(`**/api/v1/deals/${globex}/reality-check`, (route) => route.fulfill({ json: { check } }));
  await page.goto(`/app/deals/${globex}`);
  await expect(page.getByText("Move to Qualified?")).toBeVisible();
  await page.screenshot({ path: "/home/claude/shots/s6-deal-reality-check.png", fullPage: true });

  await page.goto("/app/settings/pipeline");
  await expect(page.getByRole("group", { name: /^Stage 1:/ })).toBeVisible();
  await page.screenshot({ path: "/home/claude/shots/s6-settings-pipeline.png", fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/app/deals");
  await expect(page.locator("[data-deal-id]").first()).toBeVisible();
  await page.getByRole("list", { name: "Pipeline stages" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/home/claude/shots/s6-board-mobile.png", fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log("page horizontal overflow", overflow);
  const wide = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1) {
        let clipped = false;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "hidden" || o === "scroll") { clipped = true; break; }
        }
        if (!clipped) out.push(`${el.tagName}.${(el as HTMLElement).className.toString().slice(0, 80)} r=${Math.round(r.right)}`);
      }
    }
    return out.slice(0, 10);
  });
  console.log(wide.join("\n"));
});
