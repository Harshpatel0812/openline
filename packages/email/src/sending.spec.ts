import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRawMime,
  classify,
  createUnsubscribeToken,
  GmailAdapter,
  newMessageId,
  open,
  renderEmail,
  seal,
  unknownVariables,
  verifyUnsubscribeToken,
  type OutgoingEmail,
} from "./index";

const key = randomBytes(32);
const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";

describe("secret sealing", () => {
  it("round-trips and uses a fresh IV every time", () => {
    const a = seal("app-password", key, WS);
    const b = seal("app-password", key, WS);
    expect(a).not.toBe(b);
    expect(open(a, key, WS)).toBe("app-password");
  });

  it("refuses a value moved to another workspace", () => {
    expect(() => open(seal("x", key, WS), key, OTHER_WS)).toThrow();
  });

  it("detects tampering", () => {
    const sealed = seal("x", key, WS).split(".");
    sealed[3] = Buffer.from("y").toString("base64url");
    expect(() => open(sealed.join("."), key, WS)).toThrow();
  });

  it("refuses a truncated authentication tag", () => {
    const sealed = seal("x", key, WS).split(".");
    sealed[2] = Buffer.from(sealed[2]!, "base64url").subarray(0, 4).toString("base64url");
    expect(() => open(sealed.join("."), key, WS)).toThrow(/format/);
  });
});

describe("renderEmail", () => {
  const footer = {
    mailingAddress: "1 Main St, Jersey City, NJ 07302",
    unsubscribeUrl: "https://app.openline.test/u/abc",
    senderCompany: "Acme",
  };

  it("fills variables with fallbacks and escapes contact data in HTML", () => {
    const out = renderEmail(
      "Quick question, {{firstName|there}}",
      "Hi {{firstName|there}},\n\nSaw {{company}} is hiring.",
      { firstName: "<script>alert(1)</script>", company: "Acme & Co" },
      footer,
    );
    expect(out.subject).toBe("Quick question, <script>alert(1)</script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("Acme &amp; Co");
  });

  it("uses the fallback when the value is missing", () => {
    expect(renderEmail("Hi {{firstName|there}}", "x", {}, footer).subject).toBe("Hi there");
  });

  it("always includes the postal address and unsubscribe link (CAN-SPAM)", () => {
    const out = renderEmail("s", "b", {}, footer);
    for (const part of [out.text, out.html]) {
      expect(part).toContain("Jersey City");
      expect(part).toContain("https://app.openline.test/u/abc");
    }
  });

  it("keeps subjects on one line (no header injection)", () => {
    const out = renderEmail("Hi {{firstName}}", "b", { firstName: "A\r\nBcc: x@evil.com" }, footer);
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it("reports unknown variables", () => {
    expect(unknownVariables("Hi {{firstName}} at {{compnay}}")).toEqual(["compnay"]);
  });
});

describe("unsubscribe tokens", () => {
  const claims = { workspaceId: WS, contactId: OTHER_WS };

  it("round-trips", () => {
    expect(verifyUnsubscribeToken(createUnsubscribeToken(claims, "s3cret"), "s3cret")).toEqual(
      claims,
    );
  });

  it("rejects a token signed with another secret or edited", () => {
    const token = createUnsubscribeToken(claims, "s3cret");
    expect(verifyUnsubscribeToken(token, "other")).toBeNull();
    const forged = Buffer.from(JSON.stringify({ w: OTHER_WS, c: WS })).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${token.split(".")[1]!}`, "s3cret")).toBeNull();
  });
});

describe("SMTP error classification", () => {
  it("separates auth, permanent and transient failures", () => {
    expect(classify({ code: "EAUTH" }).kind).toBe("auth");
    expect(classify({ responseCode: 530 }).kind).toBe("auth");
    expect(classify({ responseCode: 550 }).kind).toBe("permanent");
    expect(classify({ code: "ETIMEDOUT" }).kind).toBe("transient");
  });
});

describe("GmailAdapter", () => {
  const email: OutgoingEmail = {
    from: { email: "rep@acme.com", name: "Rep" },
    to: "buyer@example.com",
    subject: "Hello",
    text: "Hi",
    html: "<p>Hi</p>",
    headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    messageId: newMessageId("rep@acme.com"),
  };

  it("refreshes the access token once and sends raw MIME", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ id: "m1", threadId: "t1" }));
    }) as typeof fetch;

    const adapter = new GmailAdapter(
      { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" },
      "refresh",
      fakeFetch,
    );
    expect(await adapter.send(email)).toEqual({ providerMessageId: "m1", providerThreadId: "t1" });
    await adapter.send(email);
    expect(calls.filter((c) => c.url.includes("/token"))).toHaveLength(1);

    const raw = JSON.parse(calls[1]!.body!).raw as string;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: buyer@example.com");
    expect(mime).toContain(`Message-ID: ${email.messageId}`);
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("treats a revoked refresh token as an auth problem", async () => {
    const fakeFetch = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    const adapter = new GmailAdapter(
      { clientId: "c", clientSecret: "s", redirectUri: "r" },
      "x",
      fakeFetch,
    );
    await expect(adapter.send(email)).rejects.toMatchObject({ kind: "auth" });
  });

  it("builds MIME with threading headers for follow-ups", async () => {
    const mime = Buffer.from(
      await buildRawMime({ ...email, inReplyTo: "<ol.first@acme.com>" }),
      "base64url",
    ).toString("utf8");
    expect(mime).toContain("In-Reply-To: <ol.first@acme.com>");
    expect(mime).toContain("References: <ol.first@acme.com>");
  });

  it("builds MIME with a Reply-To when one is given", async () => {
    const withReplyTo = await buildRawMime({ ...email, replyTo: "visitor@example.com" });
    expect(Buffer.from(withReplyTo, "base64url").toString("utf8")).toContain(
      "Reply-To: visitor@example.com",
    );
    const without = await buildRawMime(email);
    expect(Buffer.from(without, "base64url").toString("utf8")).not.toContain("Reply-To:");
  });
});
