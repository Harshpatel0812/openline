/**
 * Help centre articles. Body is the small Markdown dialect rendered by
 * components/site/markdown.tsx. Keep every statement true to how the product works today —
 * check docs/product/*.md and docs/api/README.md when you change one.
 */
import { gettingStarted } from "./getting-started";
import { contactsAndMailboxes } from "./contacts-and-mailboxes";
import { sequencesAndReplies } from "./sequences-and-replies";
import { scoutComplianceDeliverability } from "./scout-compliance-deliverability";
import type { HelpArticle, HelpCategoryId } from "./types";

export type { HelpArticle, HelpCategoryId };

export const HELP_CATEGORIES: { id: HelpCategoryId; title: string; description: string }[] = [
  {
    id: "getting-started",
    title: "Getting started",
    description: "Set up your workspace, invite your team and send safely from day one.",
  },
  {
    id: "contacts",
    title: "Contacts and import",
    description: "Bring in your lists without duplicates, junk or past opt-outs.",
  },
  {
    id: "mailboxes",
    title: "Mailboxes",
    description: "Connect the inboxes your team sends from.",
  },
  {
    id: "sequences",
    title: "Sequences",
    description: "Steps, delays, personalisation, send windows and threading.",
  },
  {
    id: "replies",
    title: "Replies and the inbox",
    description: "How replies are found, labelled and stop a sequence.",
  },
  {
    id: "scout",
    title: "Scout",
    description: "Drafts with citations, approval, budgets and turning it off.",
  },
  {
    id: "compliance",
    title: "Compliance",
    description: "CAN-SPAM, CASL, GDPR, unsubscribes and the suppression list.",
  },
  {
    id: "deliverability",
    title: "Deliverability",
    description: "Caps, spacing, bounces and the DNS records that matter.",
  },
];

export const HELP_ARTICLES: HelpArticle[] = [
  ...gettingStarted,
  ...contactsAndMailboxes,
  ...sequencesAndReplies,
  ...scoutComplianceDeliverability,
];

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug);
}

export function helpCategory(id: HelpCategoryId) {
  return HELP_CATEGORIES.find((c) => c.id === id);
}
