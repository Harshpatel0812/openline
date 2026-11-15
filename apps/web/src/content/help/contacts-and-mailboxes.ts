import type { HelpArticle } from "./types";

export const contactsAndMailboxes: HelpArticle[] = [
  {
    slug: "import-contacts-csv",
    category: "contacts",
    title: "Importing contacts from a CSV",
    summary:
      "File limits, column mapping, duplicates, consent columns and the lawful-collection confirmation.",
    updated: "2026-11-15",
    body: `
Openline shows you exactly what an import will do before it saves anything. You can upload the same file twice without creating a single duplicate.

## Before you start

- **Format:** a CSV file saved as **CSV UTF-8**. Excel's BOM-prefixed files are fine. Comma, semicolon and tab separators are detected automatically. Excel workbooks (\`.xlsx\`) aren't accepted — use **File → Save As → CSV UTF-8** first.
- **Size:** up to 5 MB and 10,000 rows per file. Larger files are rejected up front with the row count, never silently cut short — split them and import the parts.
- **Columns:** only an email column is required. Openline also understands first name, last name, job title, phone, company domain, country (two-letter code such as \`US\` or \`CA\`), time zone (such as \`America/New_York\`), consent basis and consent date.

## Step 1 — Upload

Go to **Contacts → Import CSV** and choose your file. Column headers are matched for you — "Email", "E-mail", "Work email" and similar all count as the email column. If no email column is found, you'll be asked which column holds the addresses.

## Step 2 — Review the preview

Nothing has been saved at this point. The preview shows:

- **New contacts** and **duplicates** of contacts you already have (emails are compared case-insensitively).
- **Invalid rows**, each with its row number and reason — a missing or invalid email, an unknown country or time zone, a value that's too long, or "Duplicate of row N in this file".
- Contacts that match your **suppression list**. They import, but will never be emailed.
- The **column mapping**. Change any column and the preview recalculates. Columns you don't map are ignored.

## Step 3 — Choose what happens to duplicates

- **Skip** (the default) leaves existing contacts exactly as they are.
- **Update existing** fills in fields from the file. A blank cell never erases data, the email address never changes, and an imported consent basis never replaces one you already have.

## Step 4 — Confirm and import

Tick **"These contacts were collected lawfully and are not a purchased or scraped list"**. We store that confirmation with the import, along with who made it and when.

The import is all-or-nothing: every valid row is saved, or none are. When it finishes you'll see the final counts and can download the invalid rows as a CSV to fix and re-import.

## Consent columns

If you map a **consent basis** column, use one of: \`express\`, \`implied_purchase\`, \`implied_inquiry\`, \`legitimate_interest\` or \`none\`. Any basis other than \`none\` needs a **consent date**, or the row is marked invalid. Without a consent column, everyone imports as \`none\`.

Canadian contacts (country \`CA\`) without consent still import, but the preview warns you: Openline won't email them until consent is recorded, because Canada's anti-spam law (CASL) requires it. See [Compliance basics](/help/compliance-basics).

## Companies

When a contact's email is on a company domain, Openline creates the company (or links the existing one) automatically. Free email providers such as gmail.com or outlook.com never create a company.
`,
  },
  {
    slug: "connect-a-mailbox",
    category: "mailboxes",
    title: "Connecting a mailbox (SMTP or Gmail)",
    summary:
      "Connect Gmail with one click or any provider over SMTP, set daily caps and turn on reply detection.",
    updated: "2026-11-15",
    body: `
Openline sends from your team's own mailboxes, so replies land where your reps already work. Each person connects their own mailboxes in **Settings → Mailboxes**. You need a confirmed email address first.

## Gmail and Google Workspace (recommended for Google users)

Click **Connect Gmail** and sign in with Google. Openline asks only for permission to **send** email. We never see your Google password, and the access token is stored encrypted.

Reply detection needs permission to **read** your inbox. Openline asks for it separately, only when you turn reply detection on for that mailbox — sending works without it.

## Any other provider (SMTP)

Click **Connect SMTP** and enter:

| Field | What to enter |
| --- | --- |
| Email address | The address you send from. |
| Display name | The sender name your prospects see (optional). |
| Host and port | Your provider's SMTP server. Ports 465 (SSL/TLS) and 587 (STARTTLS) are the usual ones; 25 and 2525 also work. |
| Username and password | Usually the full email address and its password or app password. |

Openline logs in to your server to check the details **before** saving them. If the login fails you'll see why, and nothing is stored. Saved credentials are encrypted with AES-256-GCM and are never shown again, not even to admins.

### Google Workspace or Microsoft 365 over SMTP

Your normal password won't work. Turn on 2-step verification and create an **app password** for Openline.

- **Google:** \`smtp.gmail.com\`, port 465 (SSL/TLS) or 587.
- **Microsoft 365:** \`smtp.office365.com\`, port 587 (STARTTLS). Your Microsoft admin must allow SMTP AUTH for the mailbox.

A direct Outlook / Microsoft 365 connection (no app password) is **coming soon**.

### Reply detection for SMTP mailboxes

SMTP sends mail, but reading replies needs IMAP. On an SMTP mailbox, choose **Turn on reply detection** and add your IMAP server (usually port 993). It uses the same login by default, and we check it before saving, just as with SMTP.

## Daily cap

Every mailbox has a daily cap: **50 emails by default**, adjustable from 1 to 200. It counts over a rolling 24 hours, not since midnight. When a mailbox reaches its cap, its emails wait — nothing is dropped. New domains should start low; see [Deliverability basics](/help/deliverability-basics).

## Mailbox status

- **Active** — sending normally.
- **Paused** — by you, or automatically when more than 3% of its emails bounced in the last 24 hours. Fix the list, then resume.
- **Error** or **Disconnected** — the login stopped working (a changed password, a revoked Google grant). Reconnect it.

Removing a mailbox stops every enrollment that was sending from it. Nothing is sent from a mailbox after it's removed.
`,
  },
];
