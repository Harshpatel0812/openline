import { HttpStatus } from "@nestjs/common";
import type { AuthContext } from "./auth-context";
import { ApiException } from "./http";

/**
 * Sending-related actions (connecting a mailbox, activating a sequence, enrolling contacts) need a
 * confirmed email address, so a throwaway sign-up can't start sending.
 */
export function requireVerified(auth: AuthContext): void {
  if (!auth.emailVerified) {
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      "email_not_verified",
      "Confirm your email address first — check your inbox for the link.",
    );
  }
}
