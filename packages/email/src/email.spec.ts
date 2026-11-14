import { describe, expect, it } from "vitest";
import { buildUnsubscribeHeaders, isLikelyBotOpen } from "./index";

describe("buildUnsubscribeHeaders", () => {
  it("builds RFC 8058 one-click headers", () => {
    const headers = buildUnsubscribeHeaders("https://u.openline.app/x/abc", "unsub@openline.app");
    expect(headers["List-Unsubscribe"]).toBe(
      "<https://u.openline.app/x/abc>, <mailto:unsub@openline.app>",
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("refuses plain http", () => {
    expect(() => buildUnsubscribeHeaders("http://u.openline.app/x")).toThrow();
  });
});

describe("isLikelyBotOpen", () => {
  const deliveredAt = new Date("2026-11-18T15:00:00Z");

  it("flags opens within 2 seconds of delivery", () => {
    expect(isLikelyBotOpen({ deliveredAt, openedAt: new Date("2026-11-18T15:00:01Z") })).toBe(true);
  });

  it("flags known security scanners", () => {
    expect(
      isLikelyBotOpen({
        deliveredAt,
        openedAt: new Date("2026-11-18T16:00:00Z"),
        userAgent: "Mozilla/5.0 Proofpoint URL Defense",
      }),
    ).toBe(true);
  });

  it("counts a normal human open", () => {
    expect(
      isLikelyBotOpen({
        deliveredAt,
        openedAt: new Date("2026-11-18T16:00:00Z"),
        userAgent: "Mozilla/5.0 (Macintosh)",
      }),
    ).toBe(false);
  });
});
