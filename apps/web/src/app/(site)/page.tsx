import Link from "next/link";
import { buttonClasses } from "@/components/ui";
import {
  CheckIcon,
  Container,
  CtaBand,
  Screenshot,
  SectionHeading,
} from "@/components/site/blocks";
import { ScoutSpotlight } from "@/components/site/scout-spotlight";
import { SITE } from "@/config/site";
import { pageMetadata } from "@/lib/seo";

// Signed-in visitors are sent to /app by middleware.ts before this page renders.
export const metadata = {
  ...pageMetadata({
    title: "Outreach CRM for small B2B sales teams",
    description: SITE.description,
    path: "/",
  }),
  title: { absolute: "Openline — the outreach CRM that keeps you out of spam and out of trouble" },
};

const highlights = [
  {
    title: "Out of spam",
    body: "Daily caps per mailbox, random spacing between sends and an automatic pause when bounces climb. On from the first email.",
  },
  {
    title: "Out of trouble",
    body: "Suppression list, unsubscribes, Canadian and EU consent rules, your postal address and the contact's local hours — checked before every single send.",
  },
  {
    title: "True to your word",
    body: "Sequences stop the moment someone replies. One-click unsubscribe means no really means no, across your whole team.",
  },
];

const features = [
  {
    id: "contacts",
    eyebrow: "Contacts and import",
    title: "See what an import will do before it does it",
    body: "Upload a CSV and get a preview first: new contacts, duplicates, invalid rows with reasons, and anyone on your suppression list. Fix the column mapping, choose to skip or update duplicates, confirm the list was collected lawfully — then import, all or nothing.",
    points: [
      "Excel, semicolon and tab-separated files just work",
      "Duplicates caught within the file and against existing contacts",
      "Consent basis and date imported for CASL and GDPR",
    ],
    image: "/screens/import.png",
    alt: "Openline import preview showing counts of new contacts, duplicates and invalid rows, with the detected column mapping.",
  },
  {
    id: "sequences",
    eyebrow: "Sequences with stop rules",
    title: "Follow-ups that know when to stop",
    body: "Write a few short steps with delays and {{firstName|there}}-style personalisation. Follow-ups reply in the same thread, go out only inside each contact's business hours, and stop on a reply, an unsubscribe or a bounce.",
    points: [
      "Send windows in the contact's own time zone",
      "Preview every step as a real contact will see it",
      "Out-of-office replies postpone instead of stopping",
    ],
    image: "/screens/sequence-editor.png",
    alt: "Openline sequence editor with email steps, delays in days, and a Monday-to-Friday send window.",
  },
  {
    id: "replies",
    eyebrow: "Reply inbox",
    title: "Every reply in one place, with the sequence already stopped",
    body: "Openline watches each connected mailbox for replies to your outreach — even when a colleague answers for the person you emailed — and ends their sequence before the next step can go. Replies land in one inbox, labelled interested, not now, referral, not interested, unsubscribe or out of office.",
    points: [
      "Gmail and IMAP reply detection",
      "Filter to the replies that need action",
      "Answer from the same mailbox, in the same thread",
    ],
    image: "/screens/enrollments.png",
    alt: "A sequence's enrollments in Openline: contacts who replied are marked Replied and get no further steps.",
  },
  {
    id: "compliance",
    eyebrow: "Deliverability and compliance",
    title: "Guardrails you don't have to remember to turn on",
    body: "Every email passes the same deterministic checks just before it sends. If one fails, the email waits or is skipped, and you can see exactly why. No AI decides whether something is legal to send.",
    points: [
      "Rolling 24-hour cap per mailbox and 60–300 second spacing",
      "A mailbox pauses itself above 3% bounces",
      "CASL implied consent expires on its 24- and 6-month clocks",
      "One-click unsubscribe (RFC 8058) and your postal address on every email",
    ],
    image: "/screens/mailboxes.png",
    alt: "Openline mailbox settings listing connected mailboxes with their daily cap, emails sent today and status.",
  },
];

export default function Home() {
  return (
    <>
      <section className="overflow-hidden border-b border-slate-200 bg-gradient-to-b from-indigo-50 to-white dark:border-slate-800 dark:from-indigo-950/40 dark:to-slate-950">
        <Container className="grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-[1fr_1.15fr]">
          <div>
            <p className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">
              Outreach CRM for B2B teams of 2–25 reps
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance text-slate-950 sm:text-5xl dark:text-white">
              Cold email that stays out of spam and out of trouble.
            </h1>
            <p className="mt-5 text-lg leading-8 text-slate-600 dark:text-slate-300">
              {SITE.tagline} Contacts, sequences and a reply inbox, with deliverability and
              compliance checks before every send — and an AI assistant that cites its sources and
              waits for your approval.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/signup" className={buttonClasses("primary", "lg")}>
                Start free trial
              </Link>
              <Link href="/pricing" className={buttonClasses("secondary", "lg")}>
                See pricing
              </Link>
            </div>
            <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
              14 days free on the Team plan · No card needed · Flat price per team
            </p>
          </div>
          <Screenshot
            src="/screens/contacts.png"
            alt="The Openline contacts list with names, companies, job titles and a search box."
            priority
          />
        </Container>
      </section>

      <section aria-labelledby="highlights-heading">
        <Container className="py-16 sm:py-20">
          <h2 id="highlights-heading" className="sr-only">
            Why teams choose Openline
          </h2>
          <ul className="grid gap-6 md:grid-cols-3">
            {highlights.map((h) => (
              <li
                key={h.title}
                className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
              >
                <h3 className="text-lg font-semibold text-slate-950 dark:text-white">{h.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
                  {h.body}
                </p>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      <ScoutSpotlight />

      {features.map((f, i) => (
        <section
          key={f.id}
          aria-labelledby={`${f.id}-heading`}
          className={i % 2 === 1 ? "bg-slate-50 dark:bg-slate-900/40" : undefined}
        >
          <Container className="grid items-center gap-10 py-16 sm:py-20 lg:grid-cols-2">
            <div className={i % 2 === 1 ? "lg:order-2" : undefined}>
              <SectionHeading id={`${f.id}-heading`} eyebrow={f.eyebrow} title={f.title}>
                <p>{f.body}</p>
              </SectionHeading>
              <ul className="mt-6 space-y-3">
                {f.points.map((p) => (
                  <li key={p} className="flex gap-3 text-sm text-slate-700 dark:text-slate-300">
                    <CheckIcon />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Screenshot src={f.image} alt={f.alt} />
          </Container>
        </section>
      ))}

      <CtaBand />
    </>
  );
}
