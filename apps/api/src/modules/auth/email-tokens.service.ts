import { Injectable } from "@nestjs/common";
import { and, emailTokens, eq, isNull, sql, type Tx } from "@openline/db";
import { hashToken, newToken } from "./tokens";

export type EmailTokenKind = "verify_email" | "reset_password";

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

/** Single-use email tokens (verification, password reset). Only the SHA-256 is stored. */
@Injectable()
export class EmailTokensService {
  /** Issues a new token and retires older unused ones of the same kind (only the latest works). */
  async issue(tx: Tx, userId: string, kind: EmailTokenKind): Promise<string> {
    const token = newToken();
    await tx
      .update(emailTokens)
      .set({ usedAt: new Date() })
      .where(
        and(eq(emailTokens.userId, userId), eq(emailTokens.kind, kind), isNull(emailTokens.usedAt)),
      );
    await tx.insert(emailTokens).values({
      userId,
      kind,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + (kind === "verify_email" ? VERIFY_TTL_MS : RESET_TTL_MS)),
    });
    return token;
  }

  /**
   * Marks a valid token used and returns its user, or null when unknown/expired/used.
   * One conditional UPDATE, so two concurrent uses can't both succeed.
   */
  async consume(tx: Tx, token: string, kind: EmailTokenKind): Promise<string | null> {
    const [row] = await tx
      .update(emailTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(emailTokens.tokenHash, hashToken(token)),
          eq(emailTokens.kind, kind),
          isNull(emailTokens.usedAt),
          sql`${emailTokens.expiresAt} > now()`,
        ),
      )
      .returning({ userId: emailTokens.userId });
    return row?.userId ?? null;
  }
}
