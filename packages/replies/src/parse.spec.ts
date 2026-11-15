import { describe, expect, it } from "vitest";
import { bounceReport, rawEmail } from "./__fixtures__/mail";
import {
  classifyReply,
  deterministicLabel,
  keywordClassifier,
  ownText,
  parseReturnDate,
  resumeAfterOutOfOffice,
} from "./classify";
import { MAX_BODY_CHARS, parseInbound, snippetOf, trimQuoted } from "./parse";

/** Wednesday 2026-11-18. */
const NOW = new Date("2026-11-18T15:00:00Z");

describe("parseInbound", () => {
  it("reads headers, threading ids and the trimmed text", async () => {
    const p = await parseInbound(
      rawEmail({
        messageId: "<reply1@buyer.com>",
        inReplyTo: "<ol.abc@acme.com>",
        references: "<ol.first@acme.com> <ol.abc@acme.com>",
        text: "Yes — Tuesday works.\n\nOn Wed, Nov 18, 2026 at 9:00 AM Riley <riley@acme.com> wrote:\n> Hi Jane, quick question\n> about your team",
      }),
    );
    expect(p.messageId).toBe("<reply1@buyer.com>");
    expect(p.inReplyTo).toBe("<ol.abc@acme.com>");
    expect(p.references).toEqual(["<ol.first@acme.com>", "<ol.abc@acme.com>"]);
    expect(p.from).toEqual({ email: "jane@buyer.com", name: "Jane Buyer" });
    expect(p.text).toBe("Yes — Tuesday works.");
    expect(p.autoReply).toBe(false);
    expect(p.bounce).toBeNull();
  });

  it("converts HTML-only mail to plain text (no markup survives)", async () => {
    const p = await parseInbound(
      rawEmail({
        html: '<html><body><p>Let\'s <b>talk</b>.</p><script>alert(1)</script><img src="https://x/t.gif"></body></html>',
      }),
    );
    expect(p.text).toContain("Let's talk.");
    expect(p.text).not.toMatch(/<|script|alert|t\.gif/);
  });

  it("caps the stored text and derives a stable Message-ID when there is none", async () => {
    const raw = rawEmail({ messageId: null, text: "x".repeat(50_000) });
    const a = await parseInbound(raw);
    const b = await parseInbound(raw);
    expect(a.text.length).toBe(MAX_BODY_CHARS);
    expect(a.messageId).toMatch(/^<sha256\.[0-9a-f]{40}@openline\.invalid>$/);
    expect(a.messageId).toBe(b.messageId);
  });

  it("recognises auto-reply headers", async () => {
    const variants: Record<string, string>[] = [
      { "Auto-Submitted": "auto-replied" },
      { "X-Autoreply": "yes" },
      { "X-Autorespond": "1" },
      { Precedence: "auto_reply" },
    ];
    for (const headers of variants) {
      expect((await parseInbound(rawEmail({ headers }))).autoReply).toBe(true);
    }
    expect((await parseInbound(rawEmail({ headers: { "Auto-Submitted": "no" } }))).autoReply).toBe(
      false,
    );
  });

  it("reads a delivery status notification: status, failed address and original Message-ID", async () => {
    const p = await parseInbound(
      bounceReport({
        recipient: "gone@buyer.com",
        status: "5.1.1",
        originalMessageId: "<ol.sent1@acme.com>",
      }),
    );
    expect(p.bounce).toEqual({
      status: "5.1.1",
      permanent: true,
      recipient: "gone@buyer.com",
      originalMessageId: "<ol.sent1@acme.com>",
    });
    const temporary = await parseInbound(
      bounceReport({ recipient: "x@buyer.com", status: "4.2.2" }),
    );
    expect(temporary.bounce?.permanent).toBe(false);
    expect(deterministicLabel(temporary, NOW)).toBe("ignore");
  });

  it("recognises a multipart/report DSN by its report-type parameter, from any sender (S2)", async () => {
    const p = await parseInbound(
      bounceReport({
        recipient: "gone@buyer.com",
        status: "5.1.1",
        originalMessageId: "<ol.sent1@acme.com>",
        from: "Delivery Reports <reports@relay.buyer.com>",
      }),
    );
    expect(p.bounce).toMatchObject({ status: "5.1.1", originalMessageId: "<ol.sent1@acme.com>" });
    expect(p.machineSender).toBe(false);
  });

  it("flags machine mail: Auto-Submitted, list headers, no-reply senders (M3)", async () => {
    const p = await parseInbound(
      rawEmail({
        from: "No Reply <no-reply@buyer.com>",
        headers: { "Auto-Submitted": "auto-generated", "List-Unsubscribe": "<https://x/u>" },
      }),
    );
    expect(p).toMatchObject({ autoSubmitted: "auto-generated", bulk: true, machineSender: true });
    const human = await parseInbound(rawEmail({ headers: { "Auto-Submitted": "no" } }));
    expect(human).toMatchObject({ autoSubmitted: null, bulk: false, machineSender: false });
  });

  it("reads a plain-text bounce from MAILER-DAEMON", async () => {
    const p = await parseInbound(
      rawEmail({
        from: "MAILER-DAEMON@mx.buyer.com",
        subject: "Undelivered Mail Returned to Sender",
        text: "<gone@buyer.com>: host mx.buyer.com said: 550 5.1.1 <gone@buyer.com>: Recipient address rejected",
      }),
    );
    expect(p.bounce?.permanent).toBe(true);
    expect(p.bounce?.status).toBe("5.1.1");
  });
});

describe("trimQuoted", () => {
  it.each([
    ["Thanks!\n\nOn Tue, Nov 17, 2026, Riley wrote:\n> old", "Thanks!"],
    [
      "Thanks!\nOn Tue, Nov 17, 2026 at 9:00 AM Riley Rep <riley@acme.com>\nwrote:\n> old",
      "Thanks!",
    ],
    ["Sure.\n\n-----Original Message-----\nFrom: Riley", "Sure."],
    ["Sure.\n\n________________________________\nFrom: Riley\nSent: Tuesday", "Sure."],
    ["Sure.\n\nFrom: Riley <riley@acme.com>\nSent: Tuesday, November 17, 2026\nTo: Jane", "Sure."],
    ["Merci.\n\nLe mar. 17 nov. 2026, Riley a écrit :\n> old", "Merci."],
    ["Ok\n> quoted\n> more", "Ok"],
    // H1: more languages and clients.
    ["Ja.\n\nVon: Riley <riley@acme.com>\nGesendet: Montag\nAn: Jane", "Ja."],
    ["Ja.\n\nAm 17.11.2026 um 09:00 schrieb Riley <riley@acme.com>:\n> alt", "Ja."],
    ["Sí.\n\nEl mar, 17 nov 2026 a las 9:00, Riley (<riley@acme.com>) escribió:\n> x", "Sí."],
    ["Sì.\n\nIl giorno mar 17 nov 2026, Riley ha scritto:\n> x", "Sì."],
    ["Ja.\n\nOp di 17 nov. 2026 om 09:00 schreef Riley <riley@acme.com>:\n> x", "Ja."],
    ["Ok.\n\n-----Ursprüngliche Nachricht-----\nVon: Riley", "Ok."],
    [
      "Great\n\nOn Mon, Nov 16, 2026 at 9:00 AM Riley Smith from Acme Corporation Sales\nTeam\n<riley@acme.com>\nwrote:\nHi",
      "Great",
    ],
  ])("trims %j", (input, expected) => {
    expect(trimQuoted(input)).toBe(expected);
  });

  it("ownText drops quoted lines, our footer and our unsubscribe links (H1)", () => {
    expect(
      ownText(
        "> Hi Jane\nYes!\n> Don't want to hear from us? Unsubscribe: https://a/u/abcdefghij\nDon’t want to hear from us? Unsubscribe\nSee https://app.test/u/abcdefghijk",
      ),
    ).toBe("Yes!\nSee");
  });

  it("keeps the whole text when trimming would leave nothing", () => {
    expect(trimQuoted("> only a quote")).toBe("> only a quote");
  });

  it("snippet is the first non-empty line", () => {
    expect(snippetOf("\n\n  Hello there  \nsecond")).toBe("Hello there");
  });
});

describe("classification", () => {
  it.each([
    ["Please remove me from your list", "unsubscribe"],
    ["Stop emailing me.", "unsubscribe"],
    ["Unsubscribe", "unsubscribe"],
    ["I'm out of the office until Monday", "out_of_office"],
    ["Currently on vacation", "out_of_office"],
    ["Not interested, thanks", "not_interested"],
    ["Sounds great, send me times", "other"],
  ])("keyword fallback: %j → %s", async (text, label) => {
    const r = await keywordClassifier({ text, subject: "Re: hi", from: "x@y.com" });
    expect(r.label).toBe(label);
    expect(r.source).toBe("rule");
  });

  it("keyword fallback called directly ignores quoted lines, our footer and /u/ links (H1)", async () => {
    const r = await keywordClassifier({
      text: "> Hi Jane\nYes, let's talk.\n> Don't want to hear from us? Unsubscribe: https://app.test/u/abcdefghij\nDon’t want to hear from us? Unsubscribe\nhttps://app.test/u/remove-me-1234",
      subject: "Re: hi",
      from: "jane@buyer.com",
    });
    expect(r.label).toBe("other");
  });

  it("uses a valid model answer, and falls back to keywords on errors or invalid output", async () => {
    const input = { text: "please remove me", subject: "Re: hi", from: "x@y.com" };
    const good = await classifyReply(
      input,
      async () => ({ label: "interested", confidence: 0.9, summary: "Wants a demo" }),
      NOW,
    );
    expect(good).toMatchObject({ label: "interested", source: "model", summary: "Wants a demo" });

    const invalid = await classifyReply(
      input,
      async () => ({ label: "hire_me", confidence: 3 }) as never,
      NOW,
    );
    expect(invalid).toMatchObject({ label: "unsubscribe", source: "rule" });

    const broken = await classifyReply(
      input,
      async () => {
        throw new Error("model down");
      },
      NOW,
    );
    expect(broken).toMatchObject({ label: "unsubscribe", source: "rule" });

    // Only the DSN check may label a bounce (it marks the contact bounced).
    const bounce = await classifyReply(
      input,
      async () => ({ label: "bounce", confidence: 1 }),
      NOW,
    );
    expect(bounce.label).toBe("other");
  });

  it.each([
    ["I'm back on Monday, November 23.", "2026-11-23"],
    ["Out of office, returning 24 November 2026", "2026-11-24"],
    ["Away until Nov 30th", "2026-11-30"],
    ["Out until 2026-12-02. For urgent matters call Sam.", "2026-12-02"],
    ["Back in the office 12/01", "2026-12-01"],
    ["I'll be back Friday", "2026-11-20"],
    ["Back on January 5", "2027-01-05"],
    ["I am out of office with limited email access.", null],
  ])("return date in %j → %s", (text, expected) => {
    expect(parseReturnDate(text, NOW)).toBe(expected);
  });

  it("resumes the business day after the return date, or in 7 days", () => {
    // Friday Nov 20 → Monday Nov 23.
    expect(resumeAfterOutOfOffice("2026-11-20", NOW).toISOString()).toBe(
      "2026-11-23T12:00:00.000Z",
    );
    expect(resumeAfterOutOfOffice(null, NOW).toISOString()).toBe("2026-11-25T15:00:00.000Z");
  });
});
