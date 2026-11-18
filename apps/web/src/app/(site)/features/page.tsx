import Link from "next/link";
import { buttonClasses } from "@/components/ui";
import { CheckIcon, Container, CtaBand, PageHero, SoonBadge } from "@/components/site/blocks";
import { ScoutSpotlight } from "@/components/site/scout-spotlight";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Features",
  description:
    "Contacts and CSV import, sequences with stop rules, reply detection and inbox, a deals pipeline with Reality Check, HubSpot and Pipedrive sync, deliverability guardrails, compliance checks and Scout, an AI assistant that waits for your approval.",
  path: "/features",
});

const groups: {
  id: string;
  title: string;
  intro: string;
  items: { title: string; body: string }[];
}[] = [
  {
    id: "contacts",
    title: "Contacts and import",
    intro: "One clean list your whole team trusts.",
    items: [
      {
        title: "Contacts and companies",
        body: "Companies are created and linked from work email domains automatically; free email providers never create one.",
      },
      {
        title: "CSV import with preview",
        body: "New, duplicate, invalid and suppressed rows are shown before anything is saved. Up to 10,000 rows per file, all or nothing.",
      },
      {
        title: "Lawful-basis confirmation",
        body: "Every import records who confirmed the list was collected lawfully, and when.",
      },
      {
        title: "Consent records",
        body: "Basis, date and source for every contact, with history. Implied consent under CASL expires on its own after 24 or 6 months.",
      },
    ],
  },
  {
    id: "sequences",
    title: "Sequences",
    intro: "A few good emails, sent at the right moment, that stop at the right moment.",
    items: [
      {
        title: "Steps, delays and threading",
        body: "Up to 10 steps with day delays. Follow-ups reply in the same thread by default.",
      },
      {
        title: "Personalisation with fallbacks",
        body: "{{firstName|there}}, {{company}}, {{title}} and more. Typos in variables are caught on save.",
      },
      {
        title: "Local send windows",
        body: "Pick days and hours; Openline applies them in each contact's own time zone, including half-hour zones and daylight saving.",
      },
      {
        title: "Clear enroll results",
        body: "See who was enrolled and why anyone was skipped: suppressed, unsubscribed, bounced, already enrolled or missing consent.",
      },
    ],
  },
  {
    id: "replies",
    title: "Replies and inbox",
    intro: "Nobody gets a follow-up after they've answered.",
    items: [
      {
        title: "Reply detection",
        body: "Gmail and IMAP mailboxes are checked every couple of minutes. A reply — even from a colleague — stops the sequence.",
      },
      {
        title: "Labelled inbox",
        body: "Interested, not now, referral, not interested, unsubscribe, out of office, bounce. Filter to what needs action.",
      },
      {
        title: "Out-of-office handling",
        body: "Auto-replies postpone the next step until the person is back instead of ending the sequence.",
      },
      {
        title: "Reply in thread",
        body: "Answer from the same mailbox, in the same conversation, without leaving Openline.",
      },
      {
        title: "Promise Keeper",
        body: "Scout spots “I'll send it Friday” and “try me in March” and suggests a follow-up task. Nothing happens until you accept.",
      },
      {
        title: "Tasks",
        body: "Overdue, due today and the next 7 days on your Today page, with a red count when something slips.",
      },
    ],
  },
  {
    id: "pipeline",
    title: "Pipeline",
    intro: "Turn replies into deals and keep the forecast honest.",
    items: [
      {
        title: "Deals board",
        body: "One board for the team: drag deals between stages (or use the Move menu from the keyboard), with counts, totals and weighted totals per stage.",
      },
      {
        title: "Create a deal from a reply",
        body: "“Create deal” on a reply fills in the contact, the company and a name. Deals can also start from a contact or company page.",
      },
      {
        title: "Pipeline Reality Check",
        body: "Scout compares each deal's stage with what your emails actually say and flags the gaps, quoting the email. It suggests a stage; nothing moves until you accept.",
      },
      {
        title: "Stale deals and forecast",
        body: "Deals that go quiet are marked Stale and listed on Today. The forecast strip shows open, weighted and closing this month and quarter.",
      },
    ],
  },
  {
    id: "deliverability",
    title: "Deliverability",
    intro: "Sending behaviour that inbox providers trust.",
    items: [
      {
        title: "Daily cap per mailbox",
        body: "50 a day by default over a rolling 24 hours, adjustable up to 200.",
      },
      {
        title: "Human spacing",
        body: "A random 60–300 seconds between emails from the same mailbox. No bursts.",
      },
      {
        title: "Bounce auto-pause",
        body: "A mailbox pauses itself when more than 3% of its emails bounce in 24 hours.",
      },
      {
        title: "No tracking pixels",
        body: "No open pixels or rewritten links to trip spam filters. Replies are the metric.",
      },
    ],
  },
  {
    id: "compliance",
    title: "Compliance",
    intro: "The rules are code with tests, checked before every send — never an AI's guess.",
    items: [
      {
        title: "One-click unsubscribe",
        body: "RFC 8058 header plus a footer link on every email. Opt-outs are permanent and stop every sequence.",
      },
      {
        title: "Postal address required",
        body: "Your CAN-SPAM postal address goes in every footer; sequences can't start without it.",
      },
      {
        title: "CASL and GDPR checks",
        body: "Canadian contacts need valid express or implied consent; EU and UK contacts need a recorded lawful basis.",
      },
      {
        title: "Suppression list",
        body: "Emails and whole domains your team must never contact. Opt-out entries can't be removed.",
      },
      {
        title: "Compliance Copilot",
        body: "Ask “can I email them?” on any contact: Allowed, Not right now or Blocked, with every check, its reason and the rule behind it. Openline keeps a record of every check.",
      },
    ],
  },
  {
    id: "team",
    title: "Team and security",
    intro: "Right access for each person, and a record of what happened.",
    items: [
      {
        title: "Roles",
        body: "Owner, admin, manager and rep, checked by the server on every request.",
      },
      {
        title: "Invites",
        body: "Email invites with a role, valid for 7 days, revocable any time.",
      },
      {
        title: "Audit log",
        body: "Append-only log of sign-ins, role changes, imports, consent changes, unsubscribes and more.",
      },
      {
        title: "HubSpot and Pipedrive sync",
        body: "Two-way sync of contacts, companies and deals, with a dry-run preview, per-field conflict rules and opt-outs that travel to your CRM. On the Team plan and up.",
      },
      {
        title: "Workspace isolation",
        body: "Every workspace's data is walled off by row-level security in the database. Mailbox credentials are encrypted with AES-256-GCM.",
      },
    ],
  },
];

const comingSoon = [
  "Outlook / Microsoft 365 mailboxes",
  "Browser calling",
  "Mailbox warm-up",
  "Domain health dashboard",
];

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        eyebrow="Features"
        title="Everything a small team needs to send cold email safely"
        actions={
          <>
            <Link href="/signup" className={buttonClasses("primary", "lg")}>
              Start free trial
            </Link>
            <Link href="/pricing" className={buttonClasses("secondary", "lg")}>
              See pricing
            </Link>
          </>
        }
      >
        <p>
          Every feature is on every plan, except CRM sync, which starts on Team. Here&apos;s what
          Openline does today — and, clearly marked, what&apos;s coming next.
        </p>
      </PageHero>

      <nav aria-label="Feature groups" className="border-b border-slate-200 dark:border-slate-800">
        <Container className="flex gap-2 overflow-x-auto py-3">
          {groups.map((g) => (
            <a
              key={g.id}
              href={`#${g.id}`}
              className="shrink-0 rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-indigo-600 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:border-slate-700 dark:text-slate-300 dark:hover:text-indigo-300"
            >
              {g.title}
            </a>
          ))}
        </Container>
      </nav>

      <Container className="space-y-16 py-16 sm:py-20">
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`${g.id}-title`} className="scroll-mt-24" id={g.id}>
            <h2 id={`${g.id}-title`} className="text-2xl font-semibold tracking-tight">
              {g.title}
            </h2>
            <p className="mt-2 text-slate-600 dark:text-slate-400">{g.intro}</p>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {g.items.map((item) => (
                <li
                  key={item.title}
                  className="flex gap-3 rounded-xl border border-slate-200 p-5 dark:border-slate-800"
                >
                  <CheckIcon className="mt-0.5" />
                  <div>
                    <h3 className="font-semibold">{item.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-400">
                      {item.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section aria-labelledby="soon-title">
          <h2 id="soon-title" className="text-2xl font-semibold tracking-tight">
            On the roadmap
          </h2>
          <p className="mt-2 text-slate-600 dark:text-slate-400">
            Not built yet. We&apos;ll only move these up the page when you can use them.
          </p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {comingSoon.map((item) => (
              <li
                key={item}
                className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-4 py-3 text-sm dark:bg-slate-900"
              >
                <span>{item}</span>
                <SoonBadge />
              </li>
            ))}
          </ul>
        </section>
      </Container>

      <ScoutSpotlight />
      <CtaBand />
    </>
  );
}
