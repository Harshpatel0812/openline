/** Blog posts. Body uses the Markdown dialect in components/site/markdown.tsx. */

export interface BlogPost {
  slug: string;
  title: string;
  summary: string;
  category: "Deliverability" | "Outreach" | "Compliance";
  /** ISO date. */
  date: string;
  body: string;
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "why-cold-emails-land-in-spam",
    title: "Why cold emails land in spam (and the 5 fixes that matter)",
    summary:
      "Spam filters aren't reading your copy for magic words. They're watching how you send. Here's what they actually look at, and what to change first.",
    category: "Deliverability",
    date: "2026-11-10",
    body: `
Most advice about cold email and spam starts with a list of forbidden words. Delete "free", avoid exclamation marks, never write "act now". That advice isn't wrong, exactly, but it's aimed at the wrong target. Modern inbox providers care far less about the words in one email than about the behaviour of everything you send.

Think of it this way: Gmail and Outlook see billions of messages a day. They can't judge your email on its prose. What they can do is notice that a brand-new domain sent 400 near-identical messages in eleven minutes, that one in ten of them bounced, and that the few people who opened one clicked "Report spam". Those signals are cheap to measure and hard to fake. That's what puts you in the spam folder.

So here are the five fixes that move the needle, roughly in the order they matter.

## 1. Prove who you are: SPF, DKIM and DMARC

If your domain can't prove that a message really came from you, everything else is an uphill climb. Three DNS records do the proving:

- **SPF** lists the servers allowed to send for your domain.
- **DKIM** adds a cryptographic signature to each message, checked against a key in your DNS.
- **DMARC** ties the two to the address in the "From" line and tells receivers what to do when a message fails.

Since 2024, Google and Yahoo have required SPF or DKIM from everyone and all three from anyone sending at volume. Without them, a growing share of your mail is simply rejected. This is a one-hour job for whoever runs your DNS, and it's the single highest-return hour in outbound. Start DMARC at \`p=none\` so you can watch reports before you enforce anything.

## 2. Send less, and send it slower

Volume spikes are the clearest spam signal there is. A mailbox that sent five emails a day last month and five hundred today looks compromised, because that's what compromised mailboxes do.

A few rules of thumb that hold up:

- Keep each mailbox to a modest daily number. Fifty a day per inbox is a reasonable ceiling for cold outreach; less while a domain is new.
- Space messages out. Real people don't send an email every four seconds. A gap of a minute or more, varied at random, looks human because it is.
- Grow slowly. If you need more volume, add mailboxes rather than pushing one mailbox harder.

This is the fix most teams resist, because it feels like it costs pipeline. It doesn't. Ten emails that reach the inbox beat a hundred that don't.

## 3. Clean your list before you send to it

Bounces tell providers you didn't know the person you were emailing, which is exactly what a spammer looks like. A list bought last year, scraped from a directory, or exported from an old CRM can easily carry a bounce rate of 5–10%. That's enough to hurt a domain within days.

Before a list goes anywhere near a sequence:

- remove duplicates and obvious junk (role addresses like info@ and sales@ rarely reply anyway),
- drop anyone who has ever unsubscribed or asked not to be contacted,
- start with a small batch and watch the bounces before sending the rest.

And set a tripwire. If more than about 3% of a mailbox's recent sends bounce, stop sending from it until you've worked out why. It's much easier to fix a list than to repair a domain's reputation.

## 4. Make it easy to say no

It sounds backwards, but the easier you make it to unsubscribe, the fewer people mark you as spam. Someone who can't find a way out reaches for the "Report spam" button instead, and spam complaints are the most damaging signal you can collect. Google's sender guidelines ask senders to keep their reported spam rate under 0.3%, and well below that is better.

Two things help:

- a one-click unsubscribe header (the standard is RFC 8058), which mail apps turn into a visible "Unsubscribe" button next to your name,
- a plain unsubscribe line in the footer, which is a legal requirement in most places anyway.

When someone opts out, honour it immediately, and make sure it covers every sequence and every teammate, not just the one campaign.

## 5. Write like one person to another

Now the words. Not because filters are scanning for "free", but because the way you write changes how people react, and their reactions are what providers measure.

- **Plain text over designed HTML.** A first email from a person doesn't have a logo banner.
- **Skip the tracking.** Open-tracking pixels and rewritten links add hidden images and redirect domains that filters notice. Modern privacy features also trigger fake "opens", so the data isn't reliable anyway. Replies are the metric that matters.
- **No attachments or link shorteners** in a first touch.
- **Short, specific and true.** One reason you're writing, one question. Personalisation that's accurate beats personalisation that's elaborate. Getting someone's company wrong is worse than not mentioning it.
- **Stop when they reply.** A follow-up sent to someone who already answered reads as automated, because it is. That's a fast route to a complaint.

## The pattern behind all five

Every one of these fixes is about sending fewer, better messages to people who might actually want them. That's not a coincidence. Inbox providers are trying to protect their users from unwanted mail, and the most reliable way to stay out of the spam folder is to stop sending unwanted mail.

It's also why we built these guardrails into Openline as defaults rather than options: per-mailbox caps, random spacing, automatic pauses on bounces, one-click unsubscribe on every email, and sequences that stop the moment someone replies. The safe way should be the easy way.
`,
  },
  {
    slug: "how-many-follow-ups-is-too-many",
    title: "How many follow-ups is too many?",
    summary:
      "Most replies come after the first email, so following up matters. But there's a point where persistence turns into noise. Here's how to find it.",
    category: "Outreach",
    date: "2026-11-05",
    body: `
Ask ten sales leaders how many times to follow up on a cold email and you'll hear numbers from two to twelve. The honest answer is that there isn't one right number. There's a right shape: a short sequence where each message earns its place, that ends cleanly, and that stops the instant the person responds.

Here's how to think about it.

## Why follow up at all

People don't ignore a first email because they've decided no. They ignore it because it arrived during a meeting, on a Monday, under forty other messages. A polite second note a few days later is often the first time they really see you. Many replies come from the second or third touch, not the first.

So following up isn't pushy by default. Sending the same message four times is.

## The test for every follow-up

Before you add a step, ask: **if this were the only email they ever read from me, would it be worth their time?**

A follow-up that passes the test adds something:

- a different angle on the problem ("most teams we talk to hit this when they add their fifth rep"),
- a small piece of proof, such as a sentence about a similar company or a number you can stand behind,
- an easier ask ("is this even on your radar this quarter?"),
- or a useful resource with no strings attached.

A follow-up that fails the test says "just bumping this to the top of your inbox". If your step doesn't pass, cut it, whatever your target number is.

## A shape that works for most B2B teams

For a first cold sequence, three or four emails over two to three weeks is a sound default:

1. **Day 1 — the opener.** Why them, why now, one question.
2. **Day 3 or 4 — the second angle.** A short reply in the same thread with a different reason to care.
3. **Day 8 to 10 — proof or a smaller ask.** Something concrete, or an easier question.
4. **Day 15 to 18 — the close.** A friendly note that you'll stop here, and how to reach you later.

Gaps should widen as you go. Two emails in three days reads as interest; five emails in ten days reads as automation.

Keep follow-ups **in the same thread** as the opener. A reply-style message ("Re: your original subject") keeps the context in one place and looks like a conversation, not a campaign.

## The breakup email is a feature

The last message in a sequence often gets a surprising number of replies, because it's the first one that asks for nothing. "I'll leave it here. If route planning becomes a priority, I'm easy to find" gives the reader permission to say "not now, try me in March". That reply is worth more than silence, because it tells you when to come back.

It also tells the reader you're a person with judgment, not a machine with a list. That matters for the next time your name shows up in their inbox.

## When to stop early

The number of steps is your maximum, not your target. Stop immediately when:

- **They reply, in any way.** Interested, not interested, "who are you?" — the sequence is over and a human takes it from here. Nothing damages trust like an automated "just following up!" arriving after someone already answered.
- **A colleague replies for them.** If someone else at the company writes back, treat it as a reply from the account.
- **They ask to be removed.** Immediately and permanently, across every sequence your team runs. In most places it's also the law.
- **The email bounces.** Don't keep trying a dead address.

An out-of-office reply is the one exception. It isn't an answer, so don't end the sequence. Pause it until they're back.

## Signs your sequence is too long

- Your later steps get almost no replies, but your unsubscribe rate climbs with each one.
- You're struggling to write something new for step five.
- People who do reply mention how many emails they got.

If you see these, cut steps. Fewer, better touches will get you the same replies with less damage to your sending reputation and your brand.

## What about calls and LinkedIn?

Adding a different channel can lift replies, but the same principle applies across all of them: every touch has to justify itself, and the whole thing stops the moment the person engages. Five emails plus five LinkedIn messages plus three calls in two weeks isn't a sequence. It's a siege.

## The short version

- Follow up: the second and third emails often outperform the first.
- Three or four well-spaced emails over two to three weeks is plenty for most cold outreach.
- Every step must stand on its own. If it doesn't, delete it.
- End with a graceful close, and stop the moment anyone replies.

That's the logic behind how Openline sequences work: steps that thread by default, send windows in the contact's own time zone, and automatic stops on replies, unsubscribes and bounces, so the only follow-ups that go out are the ones that should.
`,
  },
  {
    slug: "can-spam-vs-casl-vs-gdpr",
    title: "CAN-SPAM vs CASL vs GDPR for B2B cold email, in plain English",
    summary:
      'Three laws, three different starting points: opt-out, opt-in, and "have a good reason". What each one asks of a B2B team sending cold email.',
    category: "Compliance",
    date: "2026-10-29",
    body: `
If your team emails prospects in the US, Canada and Europe, three laws shape what you can send: the US CAN-SPAM Act, Canada's Anti-Spam Legislation (CASL), and the EU's General Data Protection Regulation (GDPR) together with the ePrivacy rules that sit beside it. They overlap in places, but they start from very different ideas about when you're allowed to email someone.

Here's the short version of each, written for a B2B sales team.

## The one-line summary

| | CAN-SPAM (US) | CASL (Canada) | GDPR + ePrivacy (EU/UK) |
| --- | --- | --- | --- |
| Starting point | Opt-out: you may email until they say stop | Opt-in: you need consent first | You need a lawful basis, and local email rules apply |
| Consent before first email? | No | Yes, express or implied | Depends on the country |
| Unsubscribe required? | Yes | Yes | Yes, and objections to marketing must always be honoured |
| Postal address in email? | Yes | Yes (contact information) | Sender must be identifiable |

## CAN-SPAM: the opt-out model

The US is the most permissive of the three. CAN-SPAM doesn't require permission before you send a commercial email, including to business addresses. Instead, it sets rules for every message:

- **Don't mislead.** The "From" name, the reply-to address and the subject line must be honest about who you are and what the email is about.
- **Include a valid physical postal address** for your business. A street address, a post office box or a registered private mailbox all work.
- **Give a clear way to opt out**, and honour it within 10 business days. Once someone opts out, you can't email them again, and you can't sell or transfer their address.
- **Identify commercial messages** as such, in a clear and conspicuous way, unless the person has given prior consent.
- **You're responsible for your vendors.** If an agency or tool sends on your behalf, the obligations are still yours.

Penalties are per email and can run to tens of thousands of dollars each, so a large campaign that ignores opt-outs gets expensive quickly. Some states add their own rules on top.

## CASL: the opt-in model

Canada went the other way. Under CASL, you need **consent before** you send a commercial electronic message, and you carry the burden of proving it. Consent comes in two forms:

- **Express consent:** the person clearly agreed to receive your messages, for example by ticking a box or saying yes in writing. It lasts until they withdraw it.
- **Implied consent:** the law infers permission from an existing relationship. The common cases are a purchase or contract with you (valid for **two years**) and an inquiry or application from them (valid for **six months**). After that, implied consent expires.

CASL also recognises some narrower situations, such as an address someone has published prominently for business purposes without saying they don't want marketing, as long as your message relates to their role. These have conditions that are easy to get wrong, so take advice before relying on them.

Every message also needs to identify the sender, include contact information, and carry an unsubscribe mechanism that works for at least 60 days after sending and is honoured within 10 business days. Penalties can reach millions of dollars for businesses, which is why Canadian prospects deserve care.

In practice, CASL means you **record consent**: who, which kind, when you got it and where it came from. If you can't show it, don't send.

## GDPR and ePrivacy: the "good reason" model

In the EU and UK, two layers apply.

**GDPR** covers personal data, and a named person's work email is personal data. To process it, you need a **lawful basis**. For B2B outreach that's usually either consent or **legitimate interest**: you have a genuine business reason, the email is relevant to the person's role, and your interest isn't outweighed by their rights. If you rely on legitimate interest, write down your reasoning, known as a legitimate interests assessment.

GDPR also gives people rights you have to support: to know what you hold about them and where you got it, to have it deleted, and to **object to direct marketing**. That last one is absolute. Once someone objects, you stop.

**ePrivacy rules** (in the UK, the PECR regulations) decide when you can send marketing email at all, and they differ by country. Some, like the UK, generally allow unsolicited marketing email to corporate addresses with an opt-out, but treat sole traders and some partnerships like consumers. Others are much stricter and effectively expect consent even for B2B. If Europe is a real market for you, check the rules country by country.

GDPR fines can reach 4% of global annual turnover, though regulators usually start with orders to stop and fix.

## What this means for a team that emails all three

A practical way to stay on the right side of all three:

1. **Know where each contact is.** The rules follow the recipient, not you.
2. **Default to the strictest rule that applies to that person.** No consent on record for a Canadian? Don't send. No lawful basis recorded for someone in Germany? Don't send.
3. **Put a real postal address and a working unsubscribe in every email**, everywhere. It satisfies all three and costs nothing.
4. **Make opt-outs global and permanent.** One suppression list for the whole team, checked before every send.
5. **Keep proof.** When consent was obtained, from where, and when someone opted out.
6. **Don't buy lists.** You can't prove consent for them, and their bounce rates will hurt your deliverability too.

Openline is built around these steps. It works out each contact's jurisdiction, blocks Canadian contacts without valid consent (and tracks when implied consent expires), requires a lawful basis for EU and UK contacts, adds your postal address and a one-click unsubscribe to every email, and checks one suppression list before every send. Those checks are deterministic code, not an AI's judgement call.

*This article is a plain-English overview, not legal advice. Laws change and details matter. Talk to a qualified lawyer about your own outreach.*
`,
  },
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}
