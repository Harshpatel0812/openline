/** Public pricing (USD). Flat per team; every feature on every plan. Annual = 2 months free. */

export type BillingPeriod = "monthly" | "annual";

export interface Plan {
  id: "solo" | "team" | "growth" | "scale";
  name: string;
  summary: string;
  monthly: number;
  /** Per-month price when paid annually. */
  annual: number;
  users: number;
  mailboxes: number;
  contacts: number;
  emailsPerDay: number;
  support: string;
  popular?: boolean;
}

export const PLANS: Plan[] = [
  {
    id: "solo",
    name: "Solo",
    summary: "For a founder or a single rep doing their own outreach.",
    monthly: 39,
    annual: 32,
    users: 1,
    mailboxes: 2,
    contacts: 5_000,
    emailsPerDay: 200,
    support: "Email support, answered within 24 hours",
  },
  {
    id: "team",
    name: "Team",
    summary: "For a small sales team sharing one contact list and one inbox.",
    monthly: 119,
    annual: 99,
    users: 5,
    mailboxes: 10,
    contacts: 25_000,
    emailsPerDay: 1_000,
    support: "Email and chat support",
    popular: true,
  },
  {
    id: "growth",
    name: "Growth",
    summary: "For teams adding reps and running several sequences at once.",
    monthly: 279,
    annual: 232,
    users: 15,
    mailboxes: 30,
    contacts: 75_000,
    emailsPerDay: 3_000,
    support: "Priority chat support",
  },
  {
    id: "scale",
    name: "Scale",
    summary: "For larger teams that want a named person on our side.",
    monthly: 549,
    annual: 457,
    users: 40,
    mailboxes: 80,
    contacts: 200_000,
    emailsPerDay: 8_000,
    support: "Named customer success manager",
  },
];

export const ADD_ONS = [
  { name: "Extra mailbox", price: "$5 / month", note: "Connect one more sending mailbox." },
  { name: "+10,000 contacts", price: "$15 / month", note: "Raise your contact limit by 10,000." },
  { name: "Extra user", price: "$15 / month", note: "Add a seat without changing plan." },
];

/** Every plan includes all of these. `soon` marks features that are not built yet. */
export const INCLUDED_FEATURES: { group: string; items: { label: string; soon?: boolean }[] }[] = [
  {
    group: "Contacts",
    items: [
      { label: "Contacts and companies" },
      { label: "CSV import with duplicate preview" },
      { label: "Suppression list" },
      { label: "Consent records (CASL expiry tracking)" },
    ],
  },
  {
    group: "Sending",
    items: [
      { label: "Multi-step sequences with variables and threading" },
      { label: "Send window in each contact's time zone" },
      { label: "Daily caps, random spacing and bounce auto-pause" },
      { label: "One-click unsubscribe (RFC 8058)" },
      { label: "SMTP and Gmail mailboxes" },
      { label: "Outlook / Microsoft 365 mailboxes", soon: true },
      { label: "Mailbox warm-up", soon: true },
    ],
  },
  {
    group: "Replies and AI",
    items: [
      { label: "Reply detection that stops sequences" },
      { label: "Reply inbox with labels" },
      { label: "Scout drafts with citations and approval" },
      { label: "Promise Keeper" },
      { label: "Compliance Copilot" },
    ],
  },
  {
    group: "Team and admin",
    items: [
      { label: "Roles: owner, admin, manager, rep" },
      { label: "Invites and audit log" },
      { label: "Pipeline and deals", soon: true },
      { label: "HubSpot and Pipedrive sync", soon: true },
      { label: "Browser calling minutes", soon: true },
    ],
  },
];

export const PRICING_FAQ = [
  {
    q: "What happens when we hit a limit?",
    a: "We warn you at 80% and again at 100% of a limit. At 100%, sending pauses until you're back under the limit, upgrade, or add an add-on. We never charge you automatically for going over.",
  },
  {
    q: "Is every feature really on every plan?",
    a: "Yes. Plans differ only in users, mailboxes, contacts, daily sending volume and support. Compliance checks, Scout and the reply inbox are on Solo exactly as they are on Scale.",
  },
  {
    q: "How does the free trial work?",
    a: "You get the Team plan free for 14 days, with no card required. When it ends, you choose a plan — nothing is charged unless you do.",
  },
  {
    q: "What does annual billing save?",
    a: "Paying for a year costs the same as ten months — two months free — on every plan.",
  },
  {
    q: "Is the daily email number per mailbox or per team?",
    a: "Per team (workspace). Each mailbox also has its own daily cap — 50 by default, adjustable up to 200 — over a rolling 24 hours, so the plan number is a ceiling, not a target.",
  },
  {
    q: "What if we downgrade?",
    a: "Nothing is deleted. If you're over the new plan's limits, your data stays readable and you can export or tidy up; sending waits until you're back under the limits.",
  },
  {
    q: "How do we cancel?",
    a: "Any time, in your workspace settings. There's no contract and no cancellation call.",
  },
  {
    q: "Do you charge per seat?",
    a: "No. Each plan is one flat price for the whole team, with a set number of users included. Need one more person? An extra user is $15 a month.",
  },
];

export function formatPrice(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
