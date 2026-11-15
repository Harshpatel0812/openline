/** Public website contact form (epic OL-E5). Nothing here is stored; it becomes one email. */
import { z } from "zod";

export const CONTACT_FORM_TEAM_SIZES = ["1", "2-5", "6-15", "16-25", "26+"] as const;
export type ContactFormTeamSize = (typeof CONTACT_FORM_TEAM_SIZES)[number];

/** Optional form field: an empty string (what HTML forms send) means "not given". */
const optional = <T extends z.ZodType>(schema: T) =>
  z
    .union([z.literal(""), schema])
    .optional()
    .transform((v) => (v === "" || v === undefined ? undefined : (v as z.output<T>)));

export const ContactFormInputSchema = z.object({
  name: z.string().trim().min(1, "Tell us your name").max(100),
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email("Enter a valid email address"))
    .transform((v) => v.toLowerCase()),
  company: optional(z.string().trim().max(120)),
  teamSize: optional(z.enum(CONTACT_FORM_TEAM_SIZES)),
  message: z.string().trim().min(10, "Tell us a little more (at least 10 characters)").max(5000),
  /** Honeypot: hidden from people, filled in by bots. Any value means "drop silently". */
  website: z.string().max(2000).optional(),
});
export type ContactFormInput = z.infer<typeof ContactFormInputSchema>;

/**
 * Checked before full validation, so a bot that fills the hidden field never sees field errors
 * (which would teach it what to change).
 */
export const ContactFormHoneypotSchema = z.object({ website: z.string().trim().min(1) });

export interface ContactFormResponse {
  ok: true;
}
