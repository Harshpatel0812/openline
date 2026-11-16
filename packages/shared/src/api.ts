/**
 * Request/response contracts shared by the API and the web app.
 * The API validates every body with these; the web app uses them for forms and types.
 */
import { z } from "zod";
import { BILLING_PERIODS, PLAN_IDS, ROLES } from "./constants";

const email = z
  .string()
  .trim()
  .max(254)
  .email("Enter a valid email address")
  .transform((v) => v.toLowerCase());

/** Long passphrases beat complexity rules. Max length caps hashing cost (DoS). */
export const PasswordSchema = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(200, "Use at most 200 characters");

const personName = z.string().trim().min(1, "Required").max(100);

// ------------------------------------------------------------------ plans

export const PlanIdSchema = z.enum(PLAN_IDS);
export const BillingPeriodSchema = z.enum(BILLING_PERIODS);

/**
 * The plan a team intends to move to after the trial. Billing isn't switched on yet, so this is
 * intent only: nobody is charged, and they confirm before any payment.
 */
export const PlanChoiceInputSchema = z.object({
  plan: PlanIdSchema,
  billing: BillingPeriodSchema,
});
export type PlanChoiceInput = z.infer<typeof PlanChoiceInputSchema>;

export interface PlanChoiceDto {
  chosenPlan: PlanChoiceInput["plan"];
  chosenBilling: PlanChoiceInput["billing"];
}

// ------------------------------------------------------------------ auth

export const SignupInputSchema = z
  .object({
    name: personName,
    email,
    password: PasswordSchema,
    workspaceName: z.string().trim().min(1, "Required").max(100),
    /** Plan picked on /pricing before signing up (optional). */
    plan: PlanIdSchema.optional(),
    /** Billing period picked with the plan; defaults to monthly when only a plan is given. */
    billing: BillingPeriodSchema.optional(),
  })
  .refine((v) => v.billing === undefined || v.plan !== undefined, {
    message: "Pick a plan to go with the billing period",
    path: ["billing"],
  })
  .refine((v) => !v.password.toLowerCase().includes(v.email.split("@")[0] ?? "\u0000"), {
    message: "Password must not contain your email name",
    path: ["password"],
  });
export type SignupInput = z.infer<typeof SignupInputSchema>;

export const LoginInputSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const SwitchWorkspaceInputSchema = z.object({ workspaceId: z.string().uuid() });

export const RoleSchema = z.enum(ROLES);
export const InvitableRoleSchema = z.enum(["admin", "manager", "rep"]);

export interface MeResponse {
  user: { id: string; name: string; email: string; emailVerified: boolean };
  workspace: {
    id: string;
    name: string;
    plan: string;
    trialEndsAt: string;
    /** Plan picked for after the trial, or null when none was picked yet. */
    chosenPlan: z.infer<typeof PlanIdSchema> | null;
    chosenBilling: z.infer<typeof BillingPeriodSchema> | null;
  };
  role: z.infer<typeof RoleSchema>;
  workspaces: { id: string; name: string; role: z.infer<typeof RoleSchema> }[];
}

// ------------------------------------------------------------------ team

export const InviteInputSchema = z.object({ email, role: InvitableRoleSchema });
export type InviteInput = z.infer<typeof InviteInputSchema>;

export const UpdateMemberRoleInputSchema = z.object({ role: RoleSchema });

export const AcceptInviteInputSchema = z.object({
  token: z.string().min(20).max(200),
  /** Required only when the invitee has no account yet. */
  name: personName.optional(),
  password: PasswordSchema.optional(),
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteInputSchema>;

export interface MemberDto {
  userId: string;
  name: string;
  email: string;
  role: z.infer<typeof RoleSchema>;
  joinedAt: string;
}

export interface InviteDto {
  id: string;
  email: string;
  role: z.infer<typeof InvitableRoleSchema>;
  expiresAt: string;
  createdAt: string;
}

export interface InviteLookupDto {
  workspaceName: string;
  email: string;
  role: z.infer<typeof InvitableRoleSchema>;
  status: "valid" | "expired" | "used" | "revoked";
  accountExists: boolean;
}
