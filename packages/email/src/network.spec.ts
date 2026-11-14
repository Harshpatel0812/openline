import { describe, expect, it } from "vitest";
import { SendError } from "./adapter";
import { isNonPublicAddress, pinSmtpConfig, resolveSafeAddress } from "./network";

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
  ])("refuses %s", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "142.250.80.5", "2607:f8b0:4004:800::200e"])("allows %s", (address) => {
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
