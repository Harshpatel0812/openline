import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "@openline/shared";
import { PUBLIC_KEY, ROLES_KEY, type AuthedRequest } from "../../common/auth-context";
import { forbidden } from "../../common/http";
import { SessionService } from "./session.service";

/**
 * Global guard: every route needs a valid session unless marked @Public().
 * Public routes still get req.auth when a valid cookie is present.
 * @Roles(...) on a route or controller restricts it further.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) ?? false;
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const token = this.sessions.readCookie(req.cookies as Record<string, string> | undefined);
    const auth = token ? await this.sessions.resolve(token) : null;
    if (auth) req.auth = auth;

    if (isPublic) return true;
    if (!auth) {
      throw new UnauthorizedException({ code: "unauthorized", message: "Please sign in" });
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(auth.role)) throw forbidden();
    return true;
  }
}
