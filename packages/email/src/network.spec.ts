import { describe, expect, it } from "vitest";
import { SendError } from "./adapter";
import {
  isNonPublicAddress,
  pinSmtpConfig,
  resolveSafeAddress,
  sameRegistrableDomain,
} from "./network";

describe("isNonPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.0.8",
    "198.18.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    // Non-canonical spellings are compared as bytes (S7).
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "::127.0.0.1",
    "::ffff:7f00:1",
    "::FFFF:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "::ffff:0:7f00:1",
    "fe80::1%eth0",
    "fec0::1",
    "feff::1",
    "fc00::1",
    "2002:7f00:1::",
    "2001::1",
    "2001:db8::1",
    "100::1",
    "ff02::1",
    "not-an-address",
  ])("refuses %s", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "142.250.80.5",
    "2607:f8b0:4004:800::200e",
    "2607:F8B0:4004:0800:0000:0000:0000:200E",
    "::ffff:8.8.8.8",
    "2002:808:808::1",
    "2a00:1450:4001:82a::200e",
  ])("allows %s", (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});

describe("pinSmtpConfig", () => {
  const smtp = { host: "127.0.0.1", port: 587, secure: false };

  it("refuses a private SMTP host unless private hosts are allowed", async () => {
    await expect(pinSmtpConfig(smtp)).rejects.toMatchObject({ kind: "auth" });
    await expect(pinSmtpConfig(smtp)).rejects.toBeInstanceOf(SendError);
    await expect(pinSmtpConfig(smtp, { allowPrivate: true })).resolves.toMatchObject({
      host: "127.0.0.1",
      connectAddress: "127.0.0.1",
    });
  });

  it("pins a name to the address it resolved to (no second lookup at connect time)", async () => {
    const pinned = await pinSmtpConfig({ ...smtp, host: "localhost" }, { allowPrivate: true });
    expect(pinned.host).toBe("localhost");
    expect(["127.0.0.1", "::1"]).toContain(pinned.connectAddress);
  });

  it("treats a host that doesn't resolve as unreachable", async () => {
    expect(await resolveSafeAddress("no-such-host.invalid")).toBeNull();
  });
});

describe("sameRegistrableDomain", () => {
  it.each([
    ["imap.acme.com", "smtp.acme.com", true],
    ["imap.gmail.com", "smtp.gmail.com", true],
    ["outlook.office365.com", "smtp.office365.com", true],
    ["mail.acme.co.uk", "smtp.acme.co.uk", true],
    ["imap.evil.com", "smtp.acme.com", false],
    ["evil.co.uk", "acme.co.uk", false],
    ["acme.com.evil.io", "smtp.acme.com", false],
    ["203.0.113.5", "smtp.acme.com", false],
  ])("%s vs %s → %s", (a, b, expected) => {
    expect(sameRegistrableDomain(a, b)).toBe(expected);
  });
});
