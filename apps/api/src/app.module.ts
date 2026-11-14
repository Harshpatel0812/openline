import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DatabaseModule } from "./database/database.module";
import { AuditService } from "./modules/audit/audit.service";
import { AuthController } from "./modules/auth/auth.controller";
import { AuthService } from "./modules/auth/auth.service";
import { SessionGuard } from "./modules/auth/session.guard";
import { SessionService } from "./modules/auth/session.service";
import { CompaniesController } from "./modules/companies/companies.controller";
import { CompaniesService } from "./modules/companies/companies.service";
import { ComplianceController } from "./modules/compliance/compliance.controller";
import { ContactsController } from "./modules/contacts/contacts.controller";
import { ContactsService } from "./modules/contacts/contacts.service";
import { ImportService } from "./modules/contacts/import.service";
import { HealthController } from "./modules/health/health.controller";
import { MembersController } from "./modules/members/members.controller";
import { MembersService } from "./modules/members/members.service";
import { SuppressionsController } from "./modules/suppressions/suppressions.controller";
import { SuppressionsService } from "./modules/suppressions/suppressions.service";

@Module({
  imports: [DatabaseModule],
  controllers: [
    HealthController,
    ComplianceController,
    AuthController,
    MembersController,
    ContactsController,
    CompaniesController,
    SuppressionsController,
  ],
  providers: [
    AuditService,
    SessionService,
    AuthService,
    MembersService,
    CompaniesService,
    ContactsService,
    ImportService,
    SuppressionsService,
    // Every route requires a session unless marked @Public().
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
