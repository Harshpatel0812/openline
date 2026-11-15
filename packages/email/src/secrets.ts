/**
 * Sealing for mailbox credentials (SMTP passwords, OAuth refresh tokens).
 *
 * AES-256-GCM with a random 96-bit IV per value; the auth tag detects tampering. Format:
 *   v1.<ivB64url>.<tagB64url>.<ciphertextB64url>
 * The key comes from SECRETS_KEY (32 bytes, base64). In production it is loaded from AWS Secrets
 * Manager (later: KMS envelope encryption with a key per workspace). "v1" lets us rotate keys.
 * The workspace id is bound as additional authenticated data, so a sealed value copied into another
 * workspace's row will not decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function parseSecretsKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function seal(plaintext: string, key: Buffer, workspaceId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(workspaceId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function open(sealed: string, key: Buffer, workspaceId: string): string {
  const [version, ivB64, tagB64, dataB64] = sealed.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error("Unsupported sealed secret format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(workspaceId));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function sealJson(value: unknown, key: Buffer, workspaceId: string): string {
  return seal(JSON.stringify(value), key, workspaceId);
}

export function openJson<T>(sealed: string, key: Buffer, workspaceId: string): T {
  return JSON.parse(open(sealed, key, workspaceId)) as T;
}

/** IMAP login for reply detection on an SMTP mailbox (often the same as the SMTP login). */
export interface ImapSecret {
  username: string;
  password: string;
}

/**
 * Credentials stored sealed for each mailbox provider. `imap` was added in Sprint 4: secrets sealed
 * before then don't have it, so always treat it as optional.
 */
export type MailboxSecret =
  | { kind: "smtp"; username: string; password: string; imap?: ImapSecret }
  | { kind: "oauth"; refreshToken: string };
