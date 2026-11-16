import type { HelpArticle } from "./types";

/** Sprint 6 (OL-E7): deals, the pipeline board and Pipeline Reality Check. Keep true to docs/api/README.md. */
export const dealsAndPipeline: HelpArticle[] = [
  {
    slug: "deals-and-reality-check",
    category: "pipeline",
    title: "Deals and Pipeline Reality Check",
    summary:
      "Track deals on one board, see what's stale, and let Scout check each stage against what your emails actually say. Scout suggests; nothing moves until you approve.",
    updated: "2026-11-15",
    body: `
Replies turn into conversations, and conversations into deals. **Deals** gives your team one board for all of them, and **Pipeline Reality Check** keeps it honest: Scout compares each deal's stage with the evidence in your emails and flags the gaps.

> Scout suggests — nothing moves until you approve. Scout never changes a deal's stage on its own.

## Creating a deal

- From a reply in the **Inbox**: press **Create deal**. The contact, their company and a name like "Acme Tools — new deal" are filled in for you. If the contact already has open deals, they're listed so you don't create a duplicate.
- From a **contact** or **company** page: press **Create deal** in the Deals card.
- From **Deals**: press **New deal**.

A deal has a name, an owner, a stage, an optional amount and currency, an expected close date, a next step with a date, and up to 20 contacts. New deals use your workspace currency (**Settings → Workspace → Currency**); each deal can use its own.

## The board

**Deals** shows a column for each open stage, plus **Won** and **Lost** columns you can show or hide. Each column header shows how many deals it holds, their total amount and the **weighted** total (amount × the stage's probability). Totals are in your workspace currency; amounts in other currencies are listed separately and never converted.

To move a deal, drag its card to another column. On a phone or tablet, press and hold the card first. From the keyboard, use the card's **Move to…** menu (arrow keys to choose, Enter to move). Moving a deal to **Lost** asks for a short reason. If a move can't be saved, the card goes back where it was and you'll see why.

Above the board, the forecast strip shows the open pipeline, the weighted total, and what's expected to close this month and this quarter (by expected close date). Filter by owner (mine, everyone or one person), close date range, **Stale only** or **Flagged only**; the filters stay in the page address, so you can bookmark or share a view. Switch to **List** for a sortable table.

Everyone can see every deal. Reps can change the deals they own; managers, admins and owners can change all of them. On a deal's timeline, a rep sees emails from a teammate's mailbox only as "Email (in a teammate's mailbox)" with its direction and date — the same rule as the inbox.

## Stale deals and Today

A deal is **Stale** when nothing has happened on it for longer than its stage allows (14 days by default). Activity means an email sent to or received from any of the deal's contacts, a task on the deal completed, a stage change or an edit. **Today** lists your deals that are stale or past their next-step date under **Deals needing attention**.

## Stages

Owners and admins edit stages in **Settings → Pipeline**: rename, reorder, set the probability, the stale limit and up to five **entry criteria** — what should be true before a deal reaches the stage, such as "Budget discussed". Tie a criterion to an evidence type and Reality Check looks for it. Open stages come first, followed by exactly one Won and one Lost stage. A stage that still holds deals can't be removed or change kind until its deals move.

## Pipeline Reality Check

On each deal's page, the **Reality Check** panel shows when the deal was last checked and what was found. Press **Check now** to run it (up to 10 times a deal a day); it also runs once a day for deals with new activity.

**Date checks run without AI**, even with Scout off or the month's Scout budget used up: Openline's own rules flag a next-step date that has passed, a deal past the first stage with no next step, a close date in the past on an open deal, and stale deals.

With Scout on, Scout also reads the deal's emails from the last 90 days and looks for evidence such as a decision maker taking part, budget, a confirmed need, a timeline, a proposal sent or a verbal yes. **Evidence must be quoted from a real email**: every Yes or No comes with the exact words from the email and a link to it. If Scout can't quote it word for word, it doesn't count. You only see quotes from mail you can read; deleting a contact removes the quotes taken from their emails. Openline's own code — not the AI — then compares the evidence with your stages' entry criteria and flags, for example, "Stage says Proposal, evidence says Discovery".

Each flag shows how serious it is (high, medium or low, in words as well as colour) and, where there is one, the quote. If a flag is wrong — say you discussed the budget on a call — press **Not right** and say why. The flag stays hidden — and out of the board's flag count and the **Flagged only** filter — until there's new activity on the deal, and your answer helps us improve the check.

When the evidence points to an earlier stage, Scout suggests **Move to <stage>?** marked "Suggested by Scout — nothing moves until you accept". The deal's owner or a manager can **Accept** (the deal moves and the change is recorded) or **Dismiss** (it stays where it is). If the deal has moved since the check, the suggestion is withdrawn; run the check again.

Reality Check uses at most a quarter of your workspace's monthly Scout credits; each run sets aside its largest possible cost before it starts, so runs at the same time can't go over. Email text is treated as information, never as instructions, and only short quotes are kept with the check.
`,
  },
];
