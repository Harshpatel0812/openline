/**
 * Comparison pages. RULE: a competitor fact is only published with a `source` URL on the vendor's
 * own site and a `checkedOn` date. Unverified cells stay `null` and render as "Not yet verified".
 * Pages without any verified competitor facts are not indexed by search engines.
 */

export interface CompetitorFact {
  value: string;
  /** Vendor page the fact was checked against. */
  source: string;
}

export interface CompareRow {
  label: string;
  openline: string;
  competitor: CompetitorFact | null;
}

export interface Comparison {
  slug: string;
  competitor: string;
  /** ISO date the competitor facts were last checked, or null if never verified. */
  checkedOn: string | null;
  /** Vendor's own pages to check (shown in the dated note). */
  sources: { label: string; url: string }[];
  intro: string;
  chooseOpenline: string[];
  chooseThem: string[];
  rows: CompareRow[];
}

const OPENLINE_ROWS: Omit<CompareRow, "competitor">[] = [
  { label: "Built for", openline: "B2B sales teams of 2–25 reps" },
  {
    label: "Pricing model",
    openline: "Flat price per team, published: $39–$549 a month ($32–$457 billed annually)",
  },
  {
    label: "Features by plan",
    openline: "Every feature on every plan; HubSpot and Pipedrive sync from Team up",
  },
  { label: "Free trial", openline: "14 days of the Team plan, no card" },
  {
    label: "Going over a limit",
    openline: "Sending pauses after warnings at 80% and 100%; never auto-charged",
  },
  {
    label: "Compliance checks before every send",
    openline:
      "Suppression list, unsubscribes, bounces, CASL consent and expiry, GDPR basis, postal address",
  },
  { label: "Unsubscribe", openline: "One-click header (RFC 8058) plus footer link on every email" },
  { label: "Send window", openline: "In each contact's own time zone" },
  {
    label: "Deliverability guardrails",
    openline: "Per-mailbox daily cap, 60–300 s random spacing, auto-pause above 3% bounces",
  },
  {
    label: "Replies",
    openline: "Detected automatically; stop the sequence; labelled in one inbox",
  },
  {
    label: "AI assistant",
    openline: "Scout drafts with cited sources; nothing is sent without approval",
  },
  {
    label: "Mailboxes",
    openline: "Gmail and any SMTP provider; Outlook / Microsoft 365 coming soon",
  },
  {
    label: "Pipeline",
    openline: "Deals board with stage totals; Reality Check flags stages your emails don't back up",
  },
  { label: "Calling", openline: "Coming soon" },
  {
    label: "CRM sync (HubSpot, Pipedrive)",
    openline: "Two-way contacts, companies and deals, with a preview first (Team plan and up)",
  },
];

function rows(): CompareRow[] {
  return OPENLINE_ROWS.map((r) => ({ ...r, competitor: null }));
}

const youNeedItToday =
  "You need calling today. Openline has it on the roadmap, not in the product yet.";
const established =
  "You'd rather buy from a long-established vendor than from a young company that's still building.";

export const COMPARISONS: Comparison[] = [
  {
    slug: "openline-vs-apollo",
    competitor: "Apollo",
    checkedOn: null,
    sources: [{ label: "Apollo pricing", url: "https://www.apollo.io/pricing" }],
    intro:
      "Apollo is a larger, established vendor. Openline is a focused outreach CRM for small B2B teams that want deliverability and compliance handled before every send. Here's an honest look at when each one fits.",
    chooseOpenline: [
      "You want one flat, published price for the team, with every feature on every plan.",
      "You email prospects in Canada or Europe and need consent and lawful-basis checks enforced, not just recorded.",
      "You want guardrails on by default: daily caps, random spacing, auto-pause on bounces, stop on reply.",
      "You want AI drafts that cite their sources and never go out without a person's approval.",
    ],
    chooseThem: [
      youNeedItToday,
      established,
      "Your team is well beyond 25 reps and needs enterprise administration.",
    ],
    rows: rows(),
  },
  {
    slug: "openline-vs-outreach",
    competitor: "Outreach",
    checkedOn: null,
    sources: [{ label: "Outreach pricing", url: "https://www.outreach.io/pricing" }],
    intro:
      "Outreach is a larger, established vendor. Openline is built for teams of 2–25 reps who want to start sending this week, safely, at a price they can see up front. Here's how to decide.",
    chooseOpenline: [
      "You're a small team and want to be set up in an afternoon, without an implementation project.",
      "You want a flat, published price instead of a quote.",
      "You want compliance checks — suppression, consent, postal address, local send windows — enforced before every email.",
      "You want an AI assistant that drafts with citations and waits for your approval.",
    ],
    chooseThem: [
      youNeedItToday,
      established,
      "You run a large sales organisation with many teams, territories and admins.",
    ],
    rows: rows(),
  },
  {
    slug: "openline-vs-hubspot",
    competitor: "HubSpot",
    checkedOn: null,
    sources: [{ label: "HubSpot Sales Hub pricing", url: "https://www.hubspot.com/pricing/sales" }],
    intro:
      "HubSpot is a larger, established vendor. Openline does one job — safe, effective cold outreach for small B2B sales teams — and syncs both ways with HubSpot, so you can keep it as your CRM. Here's when each makes sense.",
    chooseOpenline: [
      "Your main job is cold outbound email, and you want deliverability and compliance guardrails built in.",
      "You want one flat price for the team, with every outreach feature on every plan.",
      "You want sequences that stop on replies automatically and respect each contact's local business hours.",
      "You want AI drafts that cite their sources and never send on their own.",
    ],
    chooseThem: [
      "You want a single platform for several departments rather than a focused outreach tool — check what their current plans include.",
      youNeedItToday,
      established,
    ],
    rows: rows(),
  },
];

export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

export function isVerified(c: Comparison): boolean {
  return c.checkedOn !== null && c.rows.some((r) => r.competitor !== null);
}
