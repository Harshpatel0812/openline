import { describe, expect, it } from "vitest";
import { ContactFormHoneypotSchema, ContactFormInputSchema } from "./contact";

const valid = { name: "Jane Doe", email: "Jane@Acme.com", message: "We have six reps." };

describe("ContactFormInputSchema", () => {
  it("accepts a minimal enquiry and normalises the email", () => {
    const parsed = ContactFormInputSchema.parse(valid);
    expect(parsed.email).toBe("jane@acme.com");
    expect(parsed.company).toBeUndefined();
    expect(parsed.teamSize).toBeUndefined();
  });

  it("treats empty optional form fields as not given", () => {
    const parsed = ContactFormInputSchema.parse({ ...valid, company: "", teamSize: "" });
    expect(parsed.company).toBeUndefined();
    expect(parsed.teamSize).toBeUndefined();
    expect(ContactFormInputSchema.parse({ ...valid, teamSize: "6-15" }).teamSize).toBe("6-15");
  });

  it("enforces lengths and the team size list", () => {
    const bad = (patch: object) => ContactFormInputSchema.safeParse({ ...valid, ...patch }).success;
    expect(bad({ name: "" })).toBe(false);
    expect(bad({ name: "x".repeat(101) })).toBe(false);
    expect(bad({ email: "nope" })).toBe(false);
    expect(bad({ email: `${"a".repeat(250)}@b.co` })).toBe(false);
    expect(bad({ company: "x".repeat(121) })).toBe(false);
    expect(bad({ teamSize: "100" })).toBe(false);
    expect(bad({ message: "too short" })).toBe(false);
    expect(bad({ message: "x".repeat(5001) })).toBe(false);
  });

  it("rejects line breaks inside the email (header injection)", () => {
    const result = ContactFormInputSchema.safeParse({
      ...valid,
      email: "jane@acme.com\r\nBcc: victim@example.com",
    });
    expect(result.success).toBe(false);
  });
});

describe("ContactFormHoneypotSchema", () => {
  it("matches only a non-empty honeypot", () => {
    expect(ContactFormHoneypotSchema.safeParse({ website: "http://spam" }).success).toBe(true);
    expect(ContactFormHoneypotSchema.safeParse({ website: "  " }).success).toBe(false);
    expect(ContactFormHoneypotSchema.safeParse({}).success).toBe(false);
  });
});
