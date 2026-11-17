import { describe, expect, it } from "vitest";
import {
  CrmConnectionPatchSchema,
  CrmFieldMappingsInputSchema,
  CrmImportInputSchema,
  crmSyncEntitled,
} from "./crm";

describe("CRM sync entitlement (Team plan and up, feature flag override)", () => {
  it("follows the plan when the flag is unset", () => {
    expect(crmSyncEntitled({ plan: "solo", crmSyncEnabled: null })).toBe(false);
    for (const plan of ["team", "growth", "scale", "trial"]) {
      expect(crmSyncEntitled({ plan, crmSyncEnabled: null })).toBe(true);
    }
  });
  it("the workspace flag wins either way", () => {
    expect(crmSyncEntitled({ plan: "solo", crmSyncEnabled: true })).toBe(true);
    expect(crmSyncEntitled({ plan: "scale", crmSyncEnabled: false })).toBe(false);
  });
});

describe("CRM input schemas", () => {
  const row = (localField: string, remoteField: string | null = "x") => ({
    object: "contact" as const,
    localField,
    remoteField,
    direction: "both" as const,
  });

  it("accepts standard and custom fields, rejects unknown ones", () => {
    expect(
      CrmFieldMappingsInputSchema.safeParse({
        mappings: [row("firstName", null), row("custom.tier")],
      }).success,
    ).toBe(true);
    expect(CrmFieldMappingsInputSchema.safeParse({ mappings: [row("email")] }).success).toBe(false);
    expect(
      CrmFieldMappingsInputSchema.safeParse({ mappings: [row("custom.Bad Key")] }).success,
    ).toBe(false);
    expect(
      CrmFieldMappingsInputSchema.safeParse({ mappings: [row("custom.tier", null)] }).success,
    ).toBe(false);
  });

  it("caps custom mappings at 20 per object and refuses duplicates", () => {
    const many = Array.from({ length: 21 }, (_, i) => row(`custom.f${i}`, `p${i}`));
    expect(CrmFieldMappingsInputSchema.safeParse({ mappings: many }).success).toBe(false);
    expect(CrmFieldMappingsInputSchema.safeParse({ mappings: many.slice(0, 20) }).success).toBe(
      true,
    );
    expect(
      CrmFieldMappingsInputSchema.safeParse({ mappings: [row("title"), row("title")] }).success,
    ).toBe(false);
  });

  it("import needs the lawful-basis confirmation", () => {
    const previewId = "00000000-0000-4000-8000-000000000000";
    expect(CrmImportInputSchema.safeParse({ previewId }).success).toBe(false);
    expect(CrmImportInputSchema.parse({ previewId, confirmLawfulBasis: true }).pushLocalOnly).toBe(
      false,
    );
  });

  it("patch is strict and validates options", () => {
    expect(CrmConnectionPatchSchema.safeParse({ secret: "x" }).success).toBe(false);
    expect(CrmConnectionPatchSchema.safeParse({ options: { pipedriveDailyCap: 10 } }).success).toBe(
      false,
    );
    expect(CrmConnectionPatchSchema.safeParse({ options: { contactPush: "all" } }).success).toBe(
      true,
    );
  });
});
