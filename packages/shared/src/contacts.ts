/** Contacts, companies, import and suppression contracts (Sprint 2, epic OL-E2). */
import { z } from "zod";
import type { CrmRecordLinkDto } from "./crm";

export const CONSENT_BASES = [
  "express",
  "implied_purchase",
  "implied_inquiry",
  "legitimate_interest",
  "none",
] as const;
export const ConsentBasisSchema = z.enum(CONSENT_BASES);

export const CONTACT_STATUSES = ["active", "bounced", "unsubscribed", "archived"] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const contactFields = {
  firstName: optionalText(100),
  lastName: optionalText(100),
  title: optionalText(150),
  phone: optionalText(40),
  /** IANA time zone, e.g. "America/New_York". Validated by the API. */
  timeZone: optionalText(64),
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Use a 2-letter country code like US")
    .nullable()
    .optional(),
  /** Company website domain; if absent, derived from the email unless it's free-mail. */
  companyDomain: z
    .string()
    .trim()
    .max(253)
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Use a domain like acme.com")
    .nullable()
    .optional(),
  companyName: optionalText(150),
  consentBasis: ConsentBasisSchema.optional(),
};

export const ContactCreateSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .email("Enter a valid email address")
    .transform((v) => v.toLowerCase()),
  ...contactFields,
});
export type ContactCreate = z.infer<typeof ContactCreateSchema>;

export const ContactUpdateSchema = ContactCreateSchema.partial();
export type ContactUpdate = z.infer<typeof ContactUpdateSchema>;

export const ContactListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export interface CompanyRef {
  id: string;
  name: string;
  domain: string | null;
}

export interface ContactDto {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  phone: string | null;
  timeZone: string | null;
  country: string | null;
  status: (typeof CONTACT_STATUSES)[number];
  consentBasis: z.infer<typeof ConsentBasisSchema>;
  company: CompanyRef | null;
  createdAt: string;
  updatedAt: string;
  /** CRM sync badge (OL-E8); absent when the workspace has no CRM connection. */
  crm?: CrmRecordLinkDto;
}

export interface ContactListDto {
  items: ContactDto[];
  nextCursor: string | null;
  total: number;
}

export interface CompanyDto extends CompanyRef {
  contactCount: number;
  createdAt: string;
  /** CRM sync badge (OL-E8); absent when the workspace has no CRM connection. */
  crm?: CrmRecordLinkDto;
}

// ------------------------------------------------------------------ CSV import

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 10_000;

export const ImportPreviewInputSchema = z.object({
  csv: z.string().min(1, "The file is empty").max(IMPORT_MAX_BYTES, "File is larger than 5 MB"),
});

export const ImportCommitInputSchema = ImportPreviewInputSchema.extend({
  duplicates: z.enum(["skip", "update"]),
  /** The importer confirms they have a lawful basis to contact these people. */
  confirmLawfulBasis: z.literal(true, {
    message: "Confirm you have a lawful basis to contact these people",
  }),
});

/** Contact fields a CSV column can map to. */
export const IMPORT_FIELDS = [
  "email",
  "firstName",
  "lastName",
  "title",
  "phone",
  "timeZone",
  "country",
  "companyDomain",
  "companyName",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export interface ImportPreviewDto {
  totalRows: number;
  newCount: number;
  duplicateCount: number;
  invalidCount: number;
  /** First 100 invalid rows. Row numbers are 1-based data rows (header excluded). */
  invalid: { row: number; reason: string }[];
  /** CSV header → contact field (null = ignored column). */
  mapping: Record<string, ImportField | null>;
  delimiter: "," | ";" | "\t";
  sample: ContactCreate[];
}

export interface ImportResultDto {
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
}

// ------------------------------------------------------------------ suppressions

export const SuppressionCreateSchema = z.object({
  /** "jane@acme.com" or a whole domain as "@acme.com". */
  value: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^([^\s@]+@[^\s@]+\.[^\s@]+|@[a-z0-9.-]+\.[a-z]{2,})$/, "Use an email or @domain.com"),
  reason: z.enum(["unsubscribed", "asked_not_to_contact", "bounced", "competitor", "other"]),
});

/**
 * Opt-outs the law requires us to honour permanently: they can't be removed, and nothing (CSV
 * import, CRM sync) ever rewrites them. crm_unsubscribed = an opt-out pulled from a CRM (OL-E8).
 */
export const LOCKED_SUPPRESSION_REASONS = [
  "unsubscribed",
  "asked_not_to_contact",
  "crm_unsubscribed",
] as const;

export interface SuppressionDto {
  id: string;
  value: string;
  reason: string;
  createdAt: string;
}

/** Free-mail domains never become companies. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "zoho.com",
  "yandex.com",
  "mail.com",
]);
