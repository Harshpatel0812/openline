import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import type { Role } from "@openline/shared";
import type { Request } from "express";

/** Who is calling, resolved from the session cookie by SessionGuard. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  workspaceId: string;
  role: Role;
  user: { name: string; email: string };
  /** True once the user has confirmed their email address. */
  emailVerified: boolean;
}

export type AuthedRequest = Request & { auth?: AuthContext };

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new UnauthorizedException({ code: "unauthorized", message: "Sign in" });
  return req.auth;
});

export const ROLES_KEY = "openline:roles";
/** Restrict a route to these roles (checked by SessionGuard). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const PUBLIC_KEY = "openline:public";
/** Mark a route as reachable without a session. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
