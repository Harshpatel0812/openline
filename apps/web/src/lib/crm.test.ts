import { describe, expect, it } from "vitest";
import {
  allowedDirections,
  crmBadge,
  crmCallbackErrorMessage,
  crmOf,
  prefillStageMapping,
  relativeTime,
  safeExternalUrl,
  stageMappingComplete,
  stageMappingInput,
  customKey,
  previewCounts,
  fieldMappingsInput,
  validateFieldMappings,
  crmPlanNote,
  DISCONNECT_FORGET_WARNING,
  errorCodeLabel,
  previewNote,
  type FieldMappingRow,
} from "./crm";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("relativeTime", () => {
  it("reads like a person", () => {
    expect(relativeTime(minsAgo(0), NOW)).toBe("just now");
    expect(relativeTime(minsAgo(4), NOW)).toBe("4 min ago");
    expect(relativeTime(minsAgo(180), NOW)).toBe("3 h ago");
    expect(relativeTime(minsAgo(60 * 24), NOW)).toBe("1 day ago");
    expect(relativeTime(minsAgo(-6), NOW)).toBe("in 6 min");
    expect(relativeTime("not a date", NOW)).toBe("");
  });
});

describe("crmBadge", () => {
  it("links synced records to the CRM", () => {
    const b = crmBadge(
      {
        provider: "hubspot",
        state: "linked",
        url: "https://app.hubspot.com/x/1",
        syncedAt: minsAgo(4),
      },
      NOW,
    );
    expect(b).toEqual({
      text: "Synced with HubSpot · 4 min ago",
      tone: "success",
      href: "https://app.hubspot.com/x/1",
    });
  });

  it("names deletes, pauses and errors in words", () => {
    expect(
      crmBadge({ provider: "pipedrive", state: "unlinked", reason: "deleted_in_crm" }, NOW).text,
    ).toBe("Deleted in Pipedrive");
    expect(crmBadge({ provider: "hubspot", state: "paused" }, NOW).text).toBe("Sync paused");
    expect(
      crmBadge({ provider: "hubspot", state: "unlinked", reason: "currency_mismatch" }, NOW).text,
    ).toBe("Not synced: Currency not available in the CRM");
    expect(crmBadge({ provider: "hubspot", state: "tombstone" }, NOW).href).toBeNull();
  });

  it("never links to javascript: or other hosts over http", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("http://evil.example/")).toBeNull();
    expect(safeExternalUrl("http://localhost:3911/contacts/1")).toBe(
      "http://localhost:3911/contacts/1",
    );
    expect(safeExternalUrl("nonsense")).toBeNull();
  });
});

describe("crmOf", () => {
  it("reads the optional crm field defensively", () => {
    expect(crmOf({})).toBeNull();
    expect(crmOf({ crm: null })).toBeNull();
    expect(crmOf({ crm: { provider: 1 } })).toBeNull();
    expect(crmOf({ crm: { provider: "hubspot", state: "linked" } })?.state).toBe("linked");
  });
});

describe("callback errors", () => {
  it("has a message for every documented state error, and a fallback", () => {
    for (const code of ["state_invalid", "state_expired", "state_mismatch"]) {
      expect(crmCallbackErrorMessage(code)).not.toMatch(/Please try again\.$/);
    }
    expect(crmCallbackErrorMessage("weird")).toBe("The CRM wasn't connected. Please try again.");
  });
});

describe("prefillStageMapping", () => {
  const openline = [
    { id: "o1", name: "Discovery", kind: "open" as const },
    { id: "o2", name: "Proposal", kind: "open" as const },
    { id: "o3", name: "Won", kind: "won" as const },
    { id: "o4", name: "Lost", kind: "lost" as const },
  ];
  const crm = [
    { id: "c1", name: "discovery", kind: "open" as const },
    { id: "c2", name: "Contract sent", kind: "open" as const },
    { id: "c3", name: "Closed won", kind: "won" as const },
    { id: "c4", name: "Closed lost", kind: "lost" as const },
  ];

  it("matches by name, then by won/lost kind, and leaves the rest for the admin", () => {
    const m = prefillStageMapping(openline, crm);
    expect(m.toCrm).toEqual([
      { stageId: "o1", remoteStageId: "c1" },
      { stageId: "o2", remoteStageId: null },
      { stageId: "o3", remoteStageId: "c3" },
      { stageId: "o4", remoteStageId: "c4" },
    ]);
    expect(m.fromCrm.find((r) => r.remoteStageId === "c2")?.stageId).toBeNull();
    expect(stageMappingComplete(m)).toBe(false);
  });

  it("keeps saved choices that still exist", () => {
    const m = prefillStageMapping(openline, crm, {
      toCrm: [
        { stageId: "o2", remoteStageId: "c2" },
        { stageId: "o1", remoteStageId: "gone" },
      ],
      fromCrm: [{ remoteStageId: "c2", stageId: "o2" }],
    });
    expect(m.toCrm[0]?.remoteStageId).toBe("c1");
    expect(m.toCrm[1]?.remoteStageId).toBe("c2");
    expect(stageMappingComplete(m)).toBe(true);
    expect(stageMappingInput(m).toCrm).toHaveLength(4);
  });
});

describe("field mappings", () => {
  const row = (over: Partial<FieldMappingRow>): FieldMappingRow => ({
    object: "contact",
    localField: "custom.region",
    localType: "text",
    remoteField: "region",
    direction: "both",
    sourceOfTruth: "newest",
    standard: false,
    ...over,
  });

  it("only lets picklists and read-only properties sync from the CRM", () => {
    expect(allowedDirections({ type: "enumeration", readOnly: false })).toEqual([
      "from_crm",
      "off",
    ]);
    expect(allowedDirections({ type: "text", readOnly: true })).toEqual(["from_crm", "off"]);
    expect(allowedDirections({ type: "number", readOnly: false })).toContain("both");
  });

  it("flags duplicates, blanks, wrong directions and the 20-per-object cap", () => {
    const remote = {
      contact: [
        { key: "region", label: "Region", type: "enumeration" as const, readOnly: false },
        { key: "score", label: "Score", type: "number" as const, readOnly: true },
      ],
    };
    expect(validateFieldMappings([row({})], remote)[0]).toMatch(/Picklists/);
    expect(
      validateFieldMappings([row({ remoteField: "score", direction: "to_crm" })], remote)[0],
    ).toMatch(/Read-only/);
    expect(validateFieldMappings([row({ remoteField: null })], remote)[0]).toMatch(
      /choose the CRM/,
    );
    expect(validateFieldMappings([row({ localField: "custom." })], remote)[0]).toMatch(/Name/);
    const dup = validateFieldMappings(
      [row({ direction: "from_crm" }), row({ direction: "from_crm", remoteField: "other" })],
      remote,
    );
    expect(dup[1]).toBe("This Openline field is already mapped");
    const many = Array.from({ length: 21 }, (_, i) =>
      row({ localField: `custom.f${i}`, remoteField: `p${i}` }),
    );
    expect(validateFieldMappings(many, {})[20]).toMatch(/At most 20/);
    expect(Object.keys(validateFieldMappings(many.slice(0, 20), {}))).toEqual([]);
  });
});

describe("customKey and previews", () => {
  it("builds keys the API accepts", () => {
    expect(customKey("Region Code!")).toBe("regioncode");
    expect(customKey("9lives_x")).toBe("lives_x");
  });

  it("drops UI-only fields from the PUT body", () => {
    const body = fieldMappingsInput([
      {
        object: "deal",
        localField: "custom.tier",
        localType: "number",
        remoteField: "tier",
        direction: "both",
        sourceOfTruth: "crm",
        standard: false,
      },
    ]);
    expect(body.mappings[0]).toEqual({
      object: "deal",
      localField: "custom.tier",
      remoteField: "tier",
      direction: "both",
      sourceOfTruth: "crm",
    });
  });

  it("sums the skipped buckets with their reasons", () => {
    const c = previewCounts({
      create: 3,
      link: 2,
      skipped_no_email: 1,
      skipped_other_pipeline: 4,
      only_in_openline: 5,
      matched_by_name: 1,
    });
    expect(c.skipped).toBe(5);
    expect(c.skippedReasons.map((r) => r.label)).toEqual(["no valid email", "in another pipeline"]);
    expect(c.onlyInOpenline).toBe(5);
    expect(previewCounts(undefined).create).toBe(0);
  });
});

describe("Sprint 7 review regressions", () => {
  const prod = { production: true, extraHosts: [] };
  const dev = { production: false, extraHosts: [] };

  it("S5 record links go only to CRM hosts, and to localhost only outside production", () => {
    const ok = [
      "https://app.hubspot.com/contacts/1/record/0-1/2",
      "https://app-eu1.hubspot.com/contacts/1/record/0-1/2",
      "https://acme.pipedrive.com/person/7",
    ];
    for (const url of ok) expect(safeExternalUrl(url, prod)).toBe(url);
    for (const url of [
      "https://evil.example/",
      "https://app.hubspot.com.evil.example/x",
      "https://pipedrive.com.evil.io/x",
      "https://evilpipedrive.com/x",
      "http://acme.pipedrive.com/person/7",
      "http://localhost:3911/contacts/1",
      "http://127.0.0.1:4900/hubspot-app/x",
    ])
      expect(safeExternalUrl(url, prod)).toBeNull();
    expect(safeExternalUrl("http://127.0.0.1:4900/hubspot-app/x", dev)).toBe(
      "http://127.0.0.1:4900/hubspot-app/x",
    );
    expect(safeExternalUrl("https://evil.example/", dev)).toBeNull();
    expect(
      safeExternalUrl("https://crm.eu.example/x", {
        production: true,
        extraHosts: ["crm.eu.example"],
      }),
    ).toBe("https://crm.eu.example/x");
  });

  it("Q4 a deal waiting for the stage mapping says why; new error codes read in words", () => {
    expect(
      crmBadge({ provider: "hubspot", state: "paused", reason: "stage_mapping" }, NOW).text,
    ).toBe("Sync paused · Stage mapping needs attention");
    expect(errorCodeLabel("stage_unmapped")).toBe("Stage not mapped");
    expect(errorCodeLabel("domain_taken")).toBe("Domain already used by another company");
    expect(errorCodeLabel("duplicate_value")).toBe("Duplicates another Openline record");
  });

  it("Q3 a connection on a plan without CRM sync gets an upgrade note", () => {
    expect(crmPlanNote(true)).toMatch(/paused.*disconnect/i);
    expect(crmPlanNote(true)).toMatch(/Team/);
    expect(crmPlanNote(false)).toMatch(/Team, Growth and Scale/);
  });

  it("Q12 a cut-short preview says its counts are partial", () => {
    expect(previewNote({ status: "partial" })).toMatch(/part of/i);
    expect(previewNote({ status: "succeeded" })).toBeNull();
  });

  it("Q9/S4 the disconnect dialog warns what forgetting links does", () => {
    expect(DISCONNECT_FORGET_WARNING).toMatch(/deals/i);
    expect(DISCONNECT_FORGET_WARNING).toMatch(/erased/i);
  });
});
