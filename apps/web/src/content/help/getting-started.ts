import type { HelpArticle } from "./types";

export const gettingStarted: HelpArticle[] = [
  {
    slug: "first-30-minutes",
    category: "getting-started",
    title: "Your first 30 minutes with Openline",
    summary:
      "From sign-up to a first sequence that's ready to send: the five things to do, in order.",
    updated: "2026-11-15",
    body: `
Openline is built so that the safe way to send is also the quick way. This walkthrough takes you from a new account to a sequence that's ready to go. Plan on about half an hour, most of it writing your emails.

## 1. Create your workspace and confirm your email (2 minutes)

Sign up with your name, work email, a password and a workspace name — usually your company's name. You land on **Contacts** straight away.

We send you a confirmation link (it's valid for 24 hours). You can look around before you click it, but you need a confirmed email before you can connect a mailbox, activate a sequence or enroll anyone. If the email doesn't arrive, check spam, then use **Resend email** in the banner at the top of the app.

## 2. Add your postal address and time zone (2 minutes)

Go to **Settings → Workspace** and fill in **Mailing address** — your business's physical postal address — US law (CAN-SPAM) requires one in every commercial email, so Openline adds it to the footer of every message. Until it's filled in, sequences can't be activated and nothing sends.

Set the **Default time zone** too. Openline sends inside each contact's own business hours; when a contact has no time zone, this one is used.

## 3. Connect a mailbox (5 minutes)

Go to **Settings → Mailboxes** and connect the address you'll send from — Gmail with one click, or any provider over SMTP. See [Connecting a mailbox](/help/connect-a-mailbox) for the details and the settings for Google Workspace and Microsoft 365.

Each mailbox starts with a daily cap of 50 emails. Leave it there while you learn how your domain performs.

## 4. Import your contacts (5 minutes)

Go to **Contacts → Import CSV** and upload a CSV. You'll see a preview — new contacts, duplicates, invalid rows and anyone on your suppression list — before anything is saved. See [Importing contacts from a CSV](/help/import-contacts-csv).

If you already have a list of people who must never be emailed (past unsubscribes, customers, competitors), add it in **Settings → Suppressions** first. Every send checks that list.

## 5. Build and activate a sequence (15 minutes)

Go to **Sequences → New sequence**. Write two or three short steps with a few days between them, use \`{{firstName|there}}\` instead of hard-coding names, and check the **Preview** with a real contact. Then activate it and enroll contacts. See [Building your first sequence](/help/build-your-first-sequence).

> Openline checks every email just before it sends: suppression list, unsubscribes, bounces, consent where the law requires it, your postal address, mailbox health, the contact's local business hours and your daily cap. If a check fails, that email waits or is skipped — and you can see why.

## What to do next

- Invite your teammates — see [Roles and invites](/help/roles-and-invites).
- Read [Deliverability basics](/help/deliverability-basics) before you raise any daily caps.
- Set up reply detection on each mailbox so replies stop sequences automatically — see [Replies and the inbox](/help/replies-and-inbox).
`,
  },
  {
    slug: "roles-and-invites",
    category: "getting-started",
    title: "Roles and inviting your team",
    summary: "What owners, admins, managers and reps can do, and how invites work.",
    updated: "2026-11-15",
    body: `
Every person in a workspace has one role. Roles are checked by the server on every request, so a change takes effect on that person's very next click.

## The four roles

| Role | Can do |
| --- | --- |
| Owner | Everything, including making or removing other owners. |
| Admin | Everything except changing or removing owners: invite people, change roles, manage mailboxes, workspace settings and the suppression list. |
| Manager | Work with all records, activate, pause and archive sequences, record consent and delete contacts. No team management. |
| Rep | Add and edit contacts, import, build sequences and enroll contacts from their own mailboxes. |

A workspace always has at least one owner — Openline won't let the last owner leave or be demoted. Make someone else an owner first.

## Inviting someone

Owners and admins go to **Settings → Team → Invite teammate**, enter an email and choose a role. Openline emails an invite link that is valid for 7 days, and the invite also appears under **Pending invites** with a link you can copy. Only owners can invite someone as an owner.

The person signs in (or creates an account) with the invited email address. Invites can be revoked at any time before they're accepted.

## Removing someone

Removing a member also removes the mailboxes they connected, and any sequences sending from those mailboxes stop for the affected contacts. That way nobody keeps sending in a former colleague's name.

## The audit log

Security-relevant actions — sign-ins, invites, role changes, removed members, mailbox changes, imports, sequence changes, consent changes, suppressions and unsubscribes — are written to an append-only audit log for your workspace. The application can add entries but has no permission to change or delete them.
`,
  },
];
