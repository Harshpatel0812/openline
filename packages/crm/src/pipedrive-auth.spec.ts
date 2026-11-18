/**
 * SEC-S3: Pipedrive's uninstall callback is authorized by Basic auth with our client credentials.
 * The comparison must not leak how much of a guessed header matched (constant time).
 */
import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveCrmConfig } from "./config";
import { PipedriveOAuth } from "./pipedrive";
import { createOAuth } from "./providers";

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

describe("Pipedrive uninstall Basic auth", () => {
  const config = resolveCrmConfig("test", { CRM_FAKE_BASE_URL: "http://127.0.0.1:4999" });
  const oauth = createOAuth(config, "pipedrive") as PipedriveOAuth;
  const good = `Basic ${Buffer.from("fake-pipedrive-client:fake-secret").toString("base64")}`;

  it("accepts only our credentials, compared in constant time over fixed-length digests", () => {
    expect(oauth).toBeInstanceOf(PipedriveOAuth);
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    expect(oauth.verifyBasicAuth(good)).toBe(true);
    expect(oauth.verifyBasicAuth(`${good.slice(0, -2)}xx`)).toBe(false);
    expect(oauth.verifyBasicAuth("Basic short")).toBe(false);
    expect(oauth.verifyBasicAuth(`${good}${"A".repeat(500)}`)).toBe(false);
    expect(oauth.verifyBasicAuth(undefined)).toBe(false);
    // Every presented header went through timingSafeEqual (different lengths too).
    expect(spy).toHaveBeenCalledTimes(4);
    for (const [a, b] of spy.mock.calls) expect((a as Buffer).length).toBe((b as Buffer).length);
  });
});
