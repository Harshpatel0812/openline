import { describe, expect, it, vi } from "vitest";
import { rawEmail } from "./__fixtures__/mail";
import { GmailReader, gmailOpenUrl, MAX_GMAIL_MESSAGE_BYTES, TOO_LARGE_BODY } from "./gmail";
import { parseInbound } from "./parse";
import { ImapReader, imapOptions, verifyImapLogin, type ImapClientLike } from "./imap";
import { ReadError, type ReadLimits } from "./types";

const limits = (over: Partial<ReadLimits> = {}): ReadLimits => ({
  maxMessages: 200,
  deadline: Date.now() + 30_000,
  since: new Date(Date.now() - 7 * 86_400_000),
  ...over,
});

/** A recorded INBOX: UIDVALIDITY 7, messages with UIDs 3, 5 and 9. */
function fakeImap(opts: { uidValidity?: number; fail?: "auth" | "connect" } = {}) {
  const store = new Map<number, Buffer>([
    [3, rawEmail({ messageId: "<m3@buyer.com>" })],
    [5, rawEmail({ messageId: "<m5@buyer.com>" })],
    [9, rawEmail({ messageId: "<m9@buyer.com>" })],
  ]);
  const calls = {
    searches: [] as unknown[],
    fetched: [] as string[],
    loggedOut: 0,
    options: [] as unknown[],
  };
  const client: ImapClientLike = {
    async connect() {
      if (opts.fail === "auth")
        throw Object.assign(new Error("no"), { authenticationFailed: true });
      if (opts.fail === "connect") throw new Error("ECONNREFUSED");
    },
    async mailboxOpen(path, o) {
      expect(path).toBe("INBOX");
      expect(o?.readOnly).toBe(true);
      return { uidValidity: BigInt(opts.uidValidity ?? 7), uidNext: 10, exists: store.size };
    },
    async search(query) {
      calls.searches.push(query);
      if (query.since) return [...store.keys()];
      const from = Number(query.uid!.split(":")[0]);
      const found = [...store.keys()].filter((u) => u >= from);
      return found.length ? found : [9]; // like real servers, "N:*" returns the last message
    },
    async fetchAll(range) {
      calls.fetched.push(range);
      return range.split(",").map((u) => ({ uid: Number(u), source: store.get(Number(u)) }));
    },
    async logout() {
      calls.loggedOut += 1;
    },
    close() {},
  };
  const factory = vi.fn((o: unknown) => {
    calls.options.push(o);
    return client;
  });
  return { factory, calls };
}

const settings = {
  host: "127.0.0.1",
  port: 993 as const,
  username: "riley@acme.com",
  password: "app-password",
  allowPrivate: true,
};

describe("ImapReader", () => {
  it("first sync reads the last 7 days, oldest first, with a checkpoint per message", async () => {
    const { factory, calls } = fakeImap();
    const result = await new ImapReader(settings, factory).read({}, limits());
    expect(calls.searches[0]).toEqual({ since: expect.any(Date) });
    expect(result.messages.map((m) => m.checkpoint?.lastUid)).toEqual([3, 5, 9]);
    expect(result.cursor).toEqual({ uidValidity: 7, lastUid: 9 });
    expect(calls.loggedOut).toBe(1);
  });

  it("then reads only UIDs above the cursor (ignoring the '*' quirk)", async () => {
    const { factory, calls } = fakeImap();
    const reader = new ImapReader(settings, factory);
    const next = await reader.read({ uidValidity: 7, lastUid: 4 }, limits());
    expect(calls.searches[0]).toEqual({ uid: "5:*" });
    expect(next.messages.map((m) => m.checkpoint?.lastUid)).toEqual([5, 9]);
    const none = await reader.read({ uidValidity: 7, lastUid: 9 }, limits());
    expect(none.messages).toEqual([]);
    expect(none.cursor).toEqual({ uidValidity: 7, lastUid: 9 });
  });

  it("starts over when UIDVALIDITY changed, and honours the message limit", async () => {
    const { factory, calls } = fakeImap({ uidValidity: 8 });
    const result = await new ImapReader(settings, factory).read(
      { uidValidity: 7, lastUid: 100 },
      limits({ maxMessages: 2 }),
    );
    expect(calls.searches[0]).toHaveProperty("since");
    expect(result.messages).toHaveLength(2);
    expect(result.cursor).toEqual({ uidValidity: 8, lastUid: 5 });
  });

  it("connects to the checked address, verifies TLS against the host name, requires STARTTLS on 143", () => {
    const tls = imapOptions({ ...settings, host: "imap.acme.com" }, "203.0.113.10");
    expect(tls).toMatchObject({
      host: "203.0.113.10",
      servername: "imap.acme.com",
      port: 993,
      secure: true,
      logger: false,
      tls: { rejectUnauthorized: true },
    });
    const starttls = imapOptions({ ...settings, host: "imap.acme.com", port: 143 }, "203.0.113.10");
    expect(starttls).toMatchObject({ secure: false, doSTARTTLS: true });
  });

  it("refuses private addresses outside development (SSRF) before connecting", async () => {
    const { factory } = fakeImap();
    await expect(
      new ImapReader({ ...settings, allowPrivate: false }, factory).read({}, limits()),
    ).rejects.toMatchObject({ kind: "unreachable" });
    await expect(
      verifyImapLogin({ ...settings, host: "localhost", allowPrivate: false }, factory),
    ).rejects.toBeInstanceOf(ReadError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("maps a rejected login to 'auth' and other failures to 'unreachable'", async () => {
    await expect(
      verifyImapLogin(settings, fakeImap({ fail: "auth" }).factory),
    ).rejects.toMatchObject({ kind: "auth" });
    await expect(
      verifyImapLogin(settings, fakeImap({ fail: "connect" }).factory),
    ).rejects.toMatchObject({ kind: "unreachable" });
    await expect(verifyImapLogin(settings, fakeImap().factory)).resolves.toBeUndefined();
  });
});

describe("GmailReader", () => {
  const google = { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" };
  const raw = (id: string) => rawEmail({ messageId: `<${id}@buyer.com>` }).toString("base64url");

  function fakeGmail(routes: Record<string, (url: URL) => Response>) {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      seen.push(`${url.pathname}${url.search}`);
      if (url.hostname === "oauth2.googleapis.com") {
        return routes.token?.(url) ?? Response.json({ access_token: "at", expires_in: 3600 });
      }
      for (const [prefix, handler] of Object.entries(routes)) {
        if (url.pathname.startsWith(`/gmail/v1/users/me/${prefix}`)) return handler(url);
      }
      return new Response("not found", { status: 404 });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
  }

  it("first sync lists the last 7 days and stores the profile's history id", async () => {
    const { fetchImpl, seen } = fakeGmail({
      profile: () => Response.json({ historyId: "1000" }),
      "messages/": (url) =>
        Response.json({ id: url.pathname.split("/").pop(), threadId: "t1", raw: raw("x") }),
      messages: () => Response.json({ messages: [{ id: "b" }, { id: "a" }] }),
    });
    const result = await new GmailReader(google, "rt", fetchImpl).read({}, limits());
    expect(result.cursor).toEqual({ historyId: "1000" });
    expect(result.messages.map((m) => m.providerMessageId)).toEqual(["a", "b"]); // oldest first
    expect(result.messages[0]!.providerThreadId).toBe("t1");
    expect(seen.some((s) => s.includes("q=newer_than%3A7d"))).toBe(true);
  });

  it("then follows history.list, skipping sent mail, and advances the cursor", async () => {
    const { fetchImpl } = fakeGmail({
      history: () =>
        Response.json({
          historyId: "1200",
          history: [
            {
              id: "1101",
              messagesAdded: [{ message: { id: "in1", labelIds: ["INBOX", "UNREAD"] } }],
            },
            { id: "1102", messagesAdded: [{ message: { id: "out1", labelIds: ["SENT"] } }] },
          ],
        }),
      "messages/": (url) => Response.json({ id: url.pathname.split("/").pop(), raw: raw("y") }),
    });
    const result = await new GmailReader(google, "rt", fetchImpl).read(
      { historyId: "1000" },
      limits(),
    );
    expect(result.messages.map((m) => m.providerMessageId)).toEqual(["in1"]);
    expect(result.cursor).toEqual({ historyId: "1200" });
  });

  it("starts over when the history id expired (404)", async () => {
    const { fetchImpl } = fakeGmail({
      history: () => new Response("gone", { status: 404 }),
      profile: () => Response.json({ historyId: "5000" }),
      messages: () => Response.json({}),
    });
    const result = await new GmailReader(google, "rt", fetchImpl).read(
      { historyId: "1" },
      limits(),
    );
    expect(result).toEqual({ messages: [], cursor: { historyId: "5000" } });
  });

  it("an unfinished first sync stores no history id, so the rest is read next time (L1)", async () => {
    const { fetchImpl } = fakeGmail({
      profile: () => Response.json({ historyId: "999" }),
      "messages/": (url) => Response.json({ id: url.pathname.split("/").pop(), raw: raw("z") }),
      messages: () => Response.json({ messages: [{ id: "m3" }, { id: "m2" }, { id: "m1" }] }),
    });
    const result = await new GmailReader(google, "rt", fetchImpl).read(
      {},
      limits({ deadline: Date.now() - 1 }),
    );
    expect(result).toEqual({ messages: [], cursor: { historyId: null } });
  });

  it("an unfinished restart after an expired history id stores no history id either (L1)", async () => {
    const { fetchImpl } = fakeGmail({
      history: () => new Response("gone", { status: 404 }),
      profile: () => Response.json({ historyId: "5000" }),
      "messages/": (url) => Response.json({ id: url.pathname.split("/").pop(), raw: raw("e") }),
      messages: () => Response.json({ messages: [{ id: "m2" }, { id: "m1" }] }),
    });
    const result = await new GmailReader(google, "rt", fetchImpl).read(
      { historyId: "1" },
      limits({ deadline: Date.now() - 1 }),
    );
    expect(result).toEqual({ messages: [], cursor: { historyId: null } });
  });

  it("takes the response's history id only after the last history page (L1)", async () => {
    const realNow = Date.now.bind(Date);
    let expired = false;
    const { fetchImpl } = fakeGmail({
      history: (url) => {
        if (url.searchParams.get("pageToken")) {
          return Response.json({
            historyId: "1300",
            history: [{ id: "1250", messagesAdded: [{ message: { id: "in2" } }] }],
          });
        }
        expired = true; // the deadline passes while the first page is read
        return Response.json({ historyId: "1300", nextPageToken: "p2", history: [{ id: "1101" }] });
      },
      "messages/": (url) => Response.json({ id: url.pathname.split("/").pop(), raw: raw("w") }),
    });
    const spy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (expired ? Number.MAX_SAFE_INTEGER : realNow()));
    try {
      const result = await new GmailReader(google, "rt", fetchImpl).read(
        { historyId: "1000" },
        limits(),
      );
      expect(result).toEqual({ messages: [], cursor: { historyId: "1101" } });
    } finally {
      spy.mockRestore();
    }
    const full = await new GmailReader(google, "rt", fetchImpl).read(
      { historyId: "1000" },
      limits(),
    );
    expect(full.messages.map((m) => m.providerMessageId)).toEqual(["in2"]);
    expect(full.cursor).toEqual({ historyId: "1300" });
  });

  it("never downloads a message over the size cap; matches it by its headers (S5)", async () => {
    const { fetchImpl, seen } = fakeGmail({
      history: () =>
        Response.json({
          historyId: "1200",
          history: [{ id: "1101", messagesAdded: [{ message: { id: "big" } }] }],
        }),
      "messages/": (url) =>
        url.searchParams.get("format") === "metadata"
          ? Response.json({
              id: "big",
              threadId: "t9",
              sizeEstimate: MAX_GMAIL_MESSAGE_BYTES + 1,
              payload: {
                headers: [
                  { name: "From", value: "Jane <jane@buyer.com>" },
                  { name: "Subject", value: "Re: Hi" },
                  { name: "Message-ID", value: "<big@buyer.com>" },
                  { name: "In-Reply-To", value: "<ol.1@acme.com>" },
                  { name: "Content-Type", value: "multipart/mixed; boundary=x" },
                ],
              },
            })
          : Response.json({ id: "big", raw: "x".repeat(10) }),
    });
    const result = await new GmailReader(google, "rt", fetchImpl).read(
      { historyId: "1000" },
      limits(),
    );
    expect(seen.some((s) => s.includes("format=raw"))).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.providerThreadId).toBe("t9");
    const parsed = await parseInbound(result.messages[0]!.raw);
    expect(parsed).toMatchObject({
      messageId: "<big@buyer.com>",
      inReplyTo: "<ol.1@acme.com>",
      text: TOO_LARGE_BODY,
    });
  });

  it("revoked access or a missing scope is an 'auth' error (the user must act)", async () => {
    const revoked = fakeGmail({ token: () => new Response("bad", { status: 400 }) });
    await expect(
      new GmailReader(google, "rt", revoked.fetchImpl).read({}, limits()),
    ).rejects.toMatchObject({ kind: "auth" });
    const noScope = fakeGmail({ profile: () => new Response("forbidden", { status: 403 }) });
    await expect(
      new GmailReader(google, "rt", noScope.fetchImpl).read({}, limits()),
    ).rejects.toMatchObject({ kind: "auth" });
    const down = fakeGmail({ profile: () => new Response("x", { status: 503 }) });
    await expect(
      new GmailReader(google, "rt", down.fetchImpl).read({}, limits()),
    ).rejects.toMatchObject({ kind: "transient" });
  });

  it("builds an 'open in Gmail' link only from a well-formed thread id", () => {
    expect(gmailOpenUrl("riley@acme.com", "18c2f0a1b2")).toBe(
      "https://mail.google.com/mail/u/?authuser=riley%40acme.com#all/18c2f0a1b2",
    );
    expect(gmailOpenUrl("riley@acme.com", "x/../evil")).toBeNull();
  });
});
