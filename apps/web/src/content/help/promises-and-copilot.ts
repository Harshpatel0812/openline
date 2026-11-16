import type { HelpArticle } from "./types";

/** Sprint 5 (OL-E6): Promise Keeper and Compliance Copilot. Keep true to docs/api/README.md. */
export const promisesAndCopilot: HelpArticle[] = [
  {
    slug: "promise-keeper",
    category: "scout",
    title: "Promise Keeper",
    summary:
      "Scout spots “I'll send it Friday” and “try me in March” in your emails and suggests a follow-up task. Nothing happens until you accept.",
    updated: "2026-11-15",
    body: `
Deals are lost to small broken promises: the quote you said you'd send on Friday, or the prospect who said "try me after budget in March". Promise Keeper reads your replies for commitments like these and Scout suggests a follow-up task with a due date, so nothing slips.

> Suggested by Scout — nothing happens until you accept. Scout never creates a task on its own.

## What it reads

- **Replies from your contacts** that reply detection finds in your mailbox (not bounces, out-of-office replies, automated mail or unsubscribes).
- **Replies you send from the inbox.**

It doesn't read sequence steps: a template sent to many people isn't a promise.

## What it looks for

| What was said | What Scout suggests |
| --- | --- |
| You promised: "I'll send the pricing by Friday" | A task for you, due at the end of that business day (5 p.m.) |
| They asked you to follow up later: "Try me after budget in March" | A follow-up task on the first business day of that period (10 a.m.). Their reply has already stopped their sequences. |
| They promised: "I'll check with my boss and get back to you next week" | A follow-up task for the business day after their date, so you can nudge them if nothing arrives |

"Next week" means Monday at 10 a.m. A week runs Monday to Sunday and quarters are calendar quarters; public holidays aren't taken into account. When an email names no date, Scout suggests two business days from then and marks it **No date given**. Dates are worked out by Openline's own code from the words in the email and the email's date — never by the AI model. Scout suggests at most three promises per email.

With Scout off, or after the month's Scout credits run low, a simpler rule-based check looks for the common English patterns ("I'll send … by Friday", "get back to you next week", "reach out in March").

## Accepting or dismissing a suggestion

Suggestions appear under **Promises Scout found** on the reply in the inbox, on the contact's page and on **Today**. Each one shows who promised what (quoting the words from the email), the suggested date and a link to the email it came from.

- **Accept** creates the task exactly as shown.
- **Edit** lets you change the task title and the due date and time before accepting.
- **Dismiss** removes the suggestion. No task is created.

Promise Keeper only ever suggests tasks; it never changes a sequence. Only the person whose mailbox received or sent the email, or a manager, can accept or dismiss it, and every decision is recorded in the audit log.

## Keeping the promise

Tasks from promises live in **Tasks** with your other tasks.

- **Due soon** (amber) means due within 24 hours.
- **Overdue** (red) means past due. Overdue tasks also show on **Today**, on the contact's page and as a red count next to **Tasks** in the menu.
- When you reply in the same thread after the promise, Openline asks **"Looks like you sent it — mark done?"** Choose **Mark done**, or **Not yet** to hide the question.

## Tasks

You can also add tasks yourself from **Tasks → New task** or from a contact's page: a title, a due date and time (in your own time zone), an optional contact and notes. The tabs show **Overdue**, **Today**, **Upcoming** (the next 7 days, then anything later or undated) and **Done**. "Today" follows your workspace's time zone. Reps see their own tasks; owners, admins and managers can also see everyone's and assign tasks to a teammate.
`,
  },
  {
    slug: "compliance-copilot",
    category: "compliance",
    title: "Compliance Copilot: how Openline checks every email",
    summary:
      "The rules Openline checks before every email, what Allowed, Not right now and Blocked mean, and the record it keeps of every check.",
    updated: "2026-11-15",
    body: `
Before every email — a sequence step or a reply from the inbox — Openline checks a fixed set of rules and keeps a record of every check. Compliance Copilot lets you ask the same question yourself: **can I email this person right now, and why?**

The checks are plain, tested code with fixed answers. An AI model never decides whether you may email someone.

> This is not legal advice. The checks cover the common rules for business email in the US, Canada and the EU/UK; they can't know everything about your situation. For that, ask a lawyer.

## Can I email them?

Open a contact to see the **Can I email them?** panel. It shows one of three answers, each with its own icon and words, never colour alone:

| Answer | What it means |
| --- | --- |
| **Allowed** | Every check passed for an email right now. |
| **Not right now** | Nothing blocks the contact, but it's outside their business hours. The panel shows the next allowed time in their time zone and in yours. Sequences hold the email until then. |
| **Blocked** | At least one check fails. Openline won't email this contact until it's fixed. |

Below the answer, every check is listed with its outcome, a plain-language reason and, under **Where this rule comes from**, the law or policy behind it. The panel also shows the ruleset version, so a record always says which version of the rules was used. You can check against a sequence's own sending hours instead of the default (Monday to Friday, 9 a.m. to 6 p.m. in the contact's time zone).

## The checks

| Check | Blocks or waits when |
| --- | --- |
| Suppression list | The address or its whole domain is on your suppression list, or the address is malformed. |
| Contact status | The contact unsubscribed, bounced or is archived. |
| Canadian consent (CASL) | A Canadian contact has no express or implied consent on record, withdrew it, or their implied consent has expired. |
| EU/UK lawful basis (GDPR) | An EU or UK contact has no lawful basis on record (consent, or legitimate interest with a note), or it was withdrawn. |
| Sender identity and postal address | Your workspace has no postal address in **Settings → Workspace**. |
| Unsubscribe link | Never — Openline adds an unsubscribe link and one-click unsubscribe headers to every email. It's listed so the record shows it. |
| Business hours | Outside the contact's business hours (wait), or their time zone isn't known. |

Business hours are **an Openline policy, not a law**: we only send while people are at work in their own time zone. Replies you send from the inbox aren't held for business hours.

Which country's rules apply comes from the contact's **country** field, then the country of their email domain (\`.ca\` means Canada), and otherwise the US rules.

## Implied consent in Canada expires {#casl-expiry}

Under CASL, implied consent from an existing business relationship lasts **2 years after a purchase** or **6 months after an inquiry**. After that it's gone, and Openline blocks the contact until you record express consent or a new purchase or inquiry. When implied consent will expire within 30 days, the check still passes but is marked **needs attention soon**, so you can ask for express consent in time. See [Compliance basics](/help/compliance-basics) for how to record consent.

## Before you enroll contacts

When you add contacts to a sequence, the dialog checks each one first and lists who won't be added and the first check that stops them, and who will be added but has to wait for business hours. Nothing is enrolled until you confirm. In a sequence's **Enrollments** tab, skipped or stopped rows show the same check names.

In the inbox, the reply box shows a small badge saying whether the rules allow a reply to that person.

## The compliance record

Every email Openline sends stores the result of its checks — the ruleset version, the answer, every check and when it ran — with the email. It never stores the email's text there.

Owners, admins and managers can choose **Download compliance record** on a contact's page. It downloads a file with the contact's consent history, suppression state, history of unsubscribes and consent changes, the check results of every email sent to them, and a fresh check. Use it to answer a complaint or a regulator's question. Emails sent before November 2026 show no stored check.
`,
  },
];
