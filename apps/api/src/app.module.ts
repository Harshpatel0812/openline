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
import { ContactController } from "./modules/contact/contact.controller";
import { ContactService } from "./modules/contact/contact.service";
import { ComplianceController } from "./modules/compliance/compliance.controller";
import { ContactsController } from "./modules/contacts/contacts.controller";
import { ContactsService } from "./modules/contacts/contacts.service";
import { ImportService } from "./modules/contacts/import.service";
import { HealthController } from "./modules/health/health.controller";
import { MembersController } from "./modules/members/members.controller";
import { MembersService } from "./modules/members/members.service";
import { SuppressionsController } from "./modules/suppressions/suppressions.controller";
import { SuppressionsService } from "./modules/suppressions/suppressions.service";
import { EmailTokensService } from "./modules/auth/email-tokens.service";
import { ConsentController } from "./modules/contacts/consent.controller";
import { ConsentService } from "./modules/contacts/consent.service";
import { MailboxesController } from "./modules/mailboxes/mailboxes.controller";
import { MailboxesService } from "./modules/mailboxes/mailboxes.service";
import { TransactionalMailService } from "./modules/mail/transactional-mail.service";
import { SchedulerService } from "./modules/scheduler/scheduler.service";
import { EnrollmentsService } from "./modules/sequences/enrollments.service";
import { SequencesController } from "./modules/sequences/sequences.controller";
import { SequencesService } from "./modules/sequences/sequences.service";
import { UnsubscribeController } from "./modules/unsubscribe/unsubscribe.controller";
import { UnsubscribeService } from "./modules/unsubscribe/unsubscribe.service";
import { WorkspaceController } from "./modules/workspace/workspace.controller";
import { WorkspaceService } from "./modules/workspace/workspace.service";

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
    ConsentController,
    WorkspaceController,
    MailboxesController,
    SequencesController,
    UnsubscribeController,
    ContactController,
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
    EmailTokensService,
    TransactionalMailService,
    ConsentService,
    WorkspaceService,
    MailboxesService,
    SequencesService,
    EnrollmentsService,
    UnsubscribeService,
    SchedulerService,
    ContactService,
    // Every route requires a session unless marked @Public().
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
