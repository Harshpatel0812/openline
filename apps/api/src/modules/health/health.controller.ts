import { Controller, Get } from "@nestjs/common";
import { Public } from "../../common/auth-context";

/** Used by load balancers, uptime monitors and the deploy smoke test. */
@Public()
@Controller("health")
export class HealthController {
  @Get()
  check(): { status: "ok"; service: "api"; version: string } {
    return { status: "ok", service: "api", version: process.env.GIT_SHA ?? "dev" };
  }
}
