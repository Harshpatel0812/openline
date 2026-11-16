import { describe, expect, it } from "vitest";
import { PlanChoiceInputSchema, SignupInputSchema } from "./api";
import { BILLING_PERIODS, PLAN_IDS } from "./constants";

const base = {
  name: "Jane",
  email: "jane@acme.test",
  password: "a long enough passphrase",
  workspaceName: "Acme",
};

describe("plan choice", () => {
  it("lists the four paid plans and both billing periods", () => {
    expect(PLAN_IDS).toEqual(["solo", "team", "growth", "scale"]);
    expect(BILLING_PERIODS).toEqual(["monthly", "annual"]);
  });

  it("accepts sign-up without a plan", () => {
    expect(SignupInputSchema.safeParse(base).success).toBe(true);
  });

  it("accepts sign-up with a plan and billing period", () => {
    const parsed = SignupInputSchema.parse({ ...base, plan: "team", billing: "annual" });
    expect(parsed).toMatchObject({ plan: "team", billing: "annual" });
  });

  it("rejects an unknown plan or billing period", () => {
    expect(SignupInputSchema.safeParse({ ...base, plan: "enterprise" }).success).toBe(false);
    expect(SignupInputSchema.safeParse({ ...base, plan: "team", billing: "weekly" }).success).toBe(
      false,
    );
  });

  it("rejects a billing period without a plan", () => {
    expect(SignupInputSchema.safeParse({ ...base, billing: "annual" }).success).toBe(false);
  });

  it("requires both fields to change the plan choice", () => {
    expect(PlanChoiceInputSchema.safeParse({ plan: "solo", billing: "monthly" }).success).toBe(
      true,
    );
    expect(PlanChoiceInputSchema.safeParse({ plan: "solo" }).success).toBe(false);
    expect(PlanChoiceInputSchema.safeParse({ plan: "free", billing: "monthly" }).success).toBe(
      false,
    );
  });
});
