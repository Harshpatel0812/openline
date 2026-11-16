/**
 * URLs for the "picked a plan on /pricing" journey. The choice travels as `?plan=&billing=` through
 * sign-up and sign-in, so it is never lost, and ends on the billing page (or is saved at sign-up).
 */
import { planQuery, type BillingPeriod, type PlanId } from "@/content/pricing";

export type PlanChoice = { plan: PlanId; billing: BillingPeriod } | null;

export const BILLING_PATH = "/app/settings/billing";

/** Billing page with the plan preselected (or plain billing page without a plan). */
export function billingHref(choice: PlanChoice): string {
  return `${BILLING_PATH}${planQuery(choice)}`;
}

/** Where to go after signing in: the billing page when a plan was picked, else `fallback`. */
export function afterSignIn(choice: PlanChoice, fallback: string): string {
  return choice ? billingHref(choice) : fallback;
}

/** /signup keeping the plan. */
export function signupHref(choice: PlanChoice): string {
  return `/signup${planQuery(choice)}`;
}

/** /login keeping the plan, and returning to the billing page with it preselected. */
export function loginHref(choice: PlanChoice): string {
  if (!choice) return "/login";
  const params = new URLSearchParams({
    plan: choice.plan,
    billing: choice.billing,
    next: billingHref(choice),
  });
  return `/login?${params.toString()}`;
}
