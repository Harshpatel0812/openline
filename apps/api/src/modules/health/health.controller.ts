import { Controller, Get } from "@nestjs/common";

/** Used by load balancers, uptime monitors and the deploy smoke test. */
@Controller("health")
export class HealthController {
  @Get()
  check(): { status: "ok"; service: "api"; version: string } {
    return { status: "ok", service: "api", version: process.env.GIT_SHA ?? "dev" };
  }
}
