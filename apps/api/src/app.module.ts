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
import { ContactComplianceController } from "./modules/compliance/contact-compliance.controller";
import { ContactComplianceService } from "./modules/compliance/contact-compliance.service";
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
import { InboxController } from "./modules/inbox/inbox.controller";
import { InboxService } from "./modules/inbox/inbox.service";
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
import { ScoutBudgetService } from "./modules/scout/budget.service";
import { ResearchService } from "./modules/scout/research.service";
import { ScoutModelService } from "./modules/scout/scout-model.service";
import { ScoutController } from "./modules/scout/scout.controller";
import { ScoutService } from "./modules/scout/scout.service";
import { ScoutSettingsController } from "./modules/workspace/scout-settings.controller";
import { ScoutSettingsService } from "./modules/workspace/scout-settings.service";
import { PromiseKeeperService } from "./modules/promises/promise-keeper.service";
import { PromisesController } from "./modules/promises/promises.controller";
import { PromisesService } from "./modules/promises/promises.service";
import { TasksController } from "./modules/tasks/tasks.controller";
import { TasksService } from "./modules/tasks/tasks.service";

@Module({
  imports: [DatabaseModule],
  controllers: [
    HealthController,
    ComplianceController,
    ContactComplianceController,
    AuthController,
    MembersController,
    ContactsController,
    CompaniesController,
    SuppressionsController,
    ConsentController,
    WorkspaceController,
    ScoutSettingsController,
    ScoutController,
    MailboxesController,
    InboxController,
    SequencesController,
    UnsubscribeController,
    ContactController,
    TasksController,
    PromisesController,
  ],
  providers: [
    TasksService,
    PromisesService,
    PromiseKeeperService,
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
    ScoutModelService,
    ScoutBudgetService,
    ResearchService,
    ScoutService,
    ScoutSettingsService,
    MailboxesService,
    InboxService,
    SequencesService,
    EnrollmentsService,
    UnsubscribeService,
    SchedulerService,
    ContactService,
    ContactComplianceService,
    // Every route requires a session unless marked @Public().
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
