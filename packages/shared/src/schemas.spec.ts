import { describe, expect, it } from "vitest";
import { ContactInputSchema } from "./schemas";

describe("ContactInputSchema", () => {
  it("normalises email to lower case and trims it", () => {
    const parsed = ContactInputSchema.parse({ email: "  Jane.Doe@Acme.COM " });
    expect(parsed.email).toBe("jane.doe@acme.com");
  });

  it("rejects an invalid email", () => {
    expect(ContactInputSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  it("rejects a company domain that is a URL", () => {
    const result = ContactInputSchema.safeParse({
      email: "a@b.com",
      companyDomain: "https://acme.com/about",
    });
    expect(result.success).toBe(false);
  });
});
