import { Module } from "@nestjs/common";
import { HealthController } from "./modules/health/health.controller";
import { ComplianceController } from "./modules/compliance/compliance.controller";

@Module({
  controllers: [HealthController, ComplianceController],
})
export class AppModule {}
