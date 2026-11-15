/**
 * Public-website constants. Everything that is not decided yet (domain, legal entity, address)
 * lives here, so it changes in one place.
 */

/** Canonical origin of the public site. Set NEXT_PUBLIC_SITE_URL once the domain is bought. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://openline.example").replace(
  /\/$/,
  "",
);

/** Placeholder email domain until the real domain exists. */
export const EMAIL_DOMAIN = "openline.example";

export const CONTACT_EMAILS = {
  sales: `sales@${EMAIL_DOMAIN}`,
  support: `support@${EMAIL_DOMAIN}`,
  security: `security@${EMAIL_DOMAIN}`,
  privacy: `privacy@${EMAIL_DOMAIN}`,
  hello: `hello@${EMAIL_DOMAIN}`,
} as const;

/** Placeholders shown on the legal pages until a lawyer reviews them. */
export const LEGAL = {
  companyName: "[Company legal name]",
  address: "[Address]",
  effectiveDate: "[Effective date]",
  governingLaw: "the State of New Jersey",
  /** Shown at the top of /privacy and /terms. Remove after legal review. */
  draftNotice: "Draft — under legal review",
} as const;

export const SITE = {
  name: "Openline",
  tagline: "The outreach CRM that keeps you out of spam, out of trouble, and true to your word.",
  description:
    "Openline is an outreach CRM for B2B sales teams of 2–25 reps: contacts, sequences and a reply inbox with deliverability and compliance checks before every send.",
} as const;

/** How Scout's model is described in public copy. */
export const SCOUT_MODEL_DESCRIPTION =
  "a leading AI model through AWS Bedrock with zero data retention";

export const MAIN_NAV = [
  { label: "Features", href: "/features" },
  { label: "Pricing", href: "/pricing" },
  { label: "Help", href: "/help" },
  { label: "Blog", href: "/blog" },
  { label: "Contact", href: "/contact" },
] as const;

/** Full vulnerability disclosure policy (SECURITY.md in the public repository). */
export const SECURITY_POLICY_URL =
  "https://github.com/Harshpatel0812/openline/blob/main/SECURITY.md";
