import type { HelpArticle } from "./types";

export const sequencesAndReplies: HelpArticle[] = [
  {
    slug: "build-your-first-sequence",
    category: "sequences",
    title: "Building your first sequence",
    summary:
      "Steps and delays, {{variables}} with fallbacks, send windows, threading and activation.",
    updated: "2026-11-15",
    body: `
A sequence is a short series of emails sent to each enrolled contact, a few days apart, that stops as soon as they reply. Go to **Sequences → New sequence** to start.

## Steps and delays

A sequence has up to 10 steps. Each step has a subject, a plain-text body and a delay — the number of days to wait after the previous step (0 to 60). The first step goes out at the first allowed moment after enrollment.

Three steps over about two weeks is a sensible start. See [How many follow-ups is too many?](/blog/how-many-follow-ups-is-too-many) for why.

## Personalisation with variables

Type a variable in double curly braces and Openline fills it in for each contact:

| Variable | Becomes |
| --- | --- |
| \`{{firstName}}\` | The contact's first name |
| \`{{lastName}}\` | Last name |
| \`{{fullName}}\` | First and last name together |
| \`{{email}}\` | Their email address |
| \`{{company}}\` | Their company |
| \`{{title}}\` | Their job title |
| \`{{senderName}}\` | The name of the person sending |

Add a fallback after a vertical bar for contacts with a missing value: \`Hi {{firstName|there}},\` becomes "Hi Dana," — or "Hi there," when there's no first name. Without a fallback, a missing value is left blank.

A misspelled variable such as \`{{frstName}}\` is caught when you save, so a typo never reaches a prospect.

## Preview

Use **Preview** to see every step exactly as one of your contacts will receive it, including the footer Openline adds to each email: your company name, your postal address and an unsubscribe link. You don't need to write a footer yourself.

## Threading

**Reply in the same thread** is on by default for follow-ups. The step is sent as a reply to the previous one — with "Re:" and the earlier subject, whatever you typed as this step's subject — so the prospect sees one conversation instead of several separate emails. Turn it off for a step when you want a fresh subject line.

## Send window

Choose the days and hours emails may go out — Monday to Friday, 9:00 to 18:00 by default. The window is applied in **each contact's own time zone**, so a contact in Los Angeles isn't emailed at 6 a.m. their time because your team is in New York. Contacts without a time zone use your workspace's default.

When a step falls due outside the window, it waits for the next opening.

## Activate and enroll

An owner, admin or manager activates the sequence. Your email must be confirmed and your workspace needs a postal address first.

Then choose **Enroll**, pick contacts and the mailbox to send from. Openline tells you who was enrolled and who was skipped, with a reason for each:

- already enrolled in this sequence (a contact can go through a sequence once),
- on the suppression list, unsubscribed or bounced,
- no valid consent where the law requires it — see [Compliance basics](/help/compliance-basics).

## What stops a sequence for a contact

- They reply (detected automatically — see [Replies and the inbox](/help/replies-and-inbox)), or you choose **Mark replied**.
- They unsubscribe, or their address hard-bounces.
- You pause or stop their enrollment, remove the sending mailbox, or archive the sequence.

An out-of-office auto-reply doesn't count as a reply; it postpones the next step instead.

## Changing a live sequence

You can pause and resume a sequence at any time. To keep what each contact receives consistent, the steps of a sequence can't be replaced while it has active or paused enrollments. Archiving a sequence stops all of its enrollments and can't be undone.
`,
  },
  {
    slug: "replies-and-inbox",
    category: "replies",
    title: "Replies and the inbox",
    summary:
      "How replies are detected, what each label means, out-of-office handling and replying from Openline.",
    updated: "2026-11-15",
    body: `
The fastest way to look like a spammer is to send a follow-up to someone who has already answered. Openline watches your connected mailboxes for replies and stops the sequence before the next step can go.

## Turning on reply detection

Reply detection is set per mailbox in **Settings → Mailboxes**:

- **Gmail:** turn it on and grant Google read access to the inbox (we ask for it only at this point).
- **SMTP mailboxes:** add your IMAP server details. See [Connecting a mailbox](/help/connect-a-mailbox).

Each mailbox shows whether reply detection is on, when it last checked, and any error.

## How a reply is recognised

Openline checks each mailbox about every two minutes. An incoming email counts as a reply to your outreach when:

1. it's part of the thread of an email we sent, or
2. it comes from a contact who is enrolled from that mailbox, or
3. it comes from someone else at that contact's company — a colleague answering for them — which is labelled **From a colleague**.

Newsletters, notifications and other automated mail never count. Emails that aren't replies to your outreach are ignored and **not stored**. Attachments are never downloaded.

## What happens when someone replies

The contact's enrollment ends as **Replied**, and any other active sequences for that contact in your workspace stop too. Before every send, Openline checks again for a newer reply, so a follow-up can't slip out in the meantime.

## Labels

Each reply gets a label so you can see what needs action:

| Label | Meaning |
| --- | --- |
| Interested | Wants to talk or learn more. |
| Not now | Open, but not at the moment. |
| Referral | Points you to someone else. |
| Not interested | A clear no. |
| Unsubscribe | Asked to stop ("remove me"). Treated exactly like the unsubscribe link: the address is suppressed. |
| Out of office | An auto-reply. Doesn't stop the sequence. |
| Bounce | The address doesn't exist. The contact is marked bounced. |
| Other | Anything else. |

Bounces and auto-replies are recognised from their email headers. Other labels come from Scout. When Scout is off, simple keyword rules label the obvious cases and the label shows **(rule)**. You can always change a label yourself.

## Out-of-office replies

An out-of-office reply never stops a sequence. Openline reads the return date from the message and moves the next step to one business day after it, or postpones it by 7 days when there's no date.

## The inbox

**Inbox** lists every reply from every connected mailbox, newest first. By default it shows the replies that need action (interested, referral, not now and other); filter by label or mailbox to see the rest. Reps see replies to their own mailboxes; managers, admins and owners see all of them.

Open a reply to read it as plain text, see the step it answered, change the label, reply from the same mailbox in the same thread, ask Scout for a draft, or mark it handled.
`,
  },
];
