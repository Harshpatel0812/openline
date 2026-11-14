import { z } from "zod";

export const WorkspaceIdSchema = z.string().uuid();

/** Input for creating or importing a contact. Emails are normalised to lower case. */
export const ContactInputSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  title: z.string().trim().max(150).optional(),
  companyDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Must be a domain like acme.com")
    .optional(),
  phone: z.string().trim().max(32).optional(),
});

export type ContactInput = z.infer<typeof ContactInputSchema>;

/** Standard API error shape: every endpoint returns this on failure. */
export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
