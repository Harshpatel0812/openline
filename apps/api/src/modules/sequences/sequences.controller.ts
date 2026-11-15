import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  EnrollInputSchema,
  EnrollmentActionInputSchema,
  EnrollPreviewInputSchema,
  ENROLLMENT_STATES,
  SequenceInputSchema,
  SequenceStatusInputSchema,
  type EnrollmentDto,
  type EnrollPreviewDto,
  type EnrollResultDto,
  type MessageDto,
  type SequenceDto,
} from "@openline/shared";
import { z } from "zod";
import { Auth, Roles, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { EnrollmentsService } from "./enrollments.service";
import { SequencesService } from "./sequences.service";

const ListQuery = z.object({ includeArchived: z.enum(["true", "false"]).optional() });
const PreviewInput = z.object({ contactId: z.string().uuid().optional() });
const EnrollmentListQuery = z.object({
  state: z.enum(ENROLLMENT_STATES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

@Controller()
export class SequencesController {
  constructor(
    private readonly sequences: SequencesService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  @Get("sequences")
  list(@Auth() auth: AuthContext, @Query() query: unknown): Promise<SequenceDto[]> {
    const { includeArchived } = parse(ListQuery, query);
    return this.sequences.list(auth, includeArchived === "true");
  }

  @Post("sequences")
  create(@Auth() auth: AuthContext, @Body() body: unknown): Promise<SequenceDto> {
    return this.sequences.create(auth, parse(SequenceInputSchema, body));
  }

  @Get("sequences/:id")
  get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<SequenceDto> {
    return this.sequences.get(auth, id);
  }

  @Patch("sequences/:id")
  update(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SequenceDto> {
    return this.sequences.update(auth, id, parse(SequenceInputSchema, body));
  }

  @Roles("owner", "admin", "manager")
  @Post("sequences/:id/status")
  @HttpCode(200)
  setStatus(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SequenceDto> {
    const { status } = parse(SequenceStatusInputSchema, body);
    return this.sequences.setStatus(auth, id, status);
  }

  @Post("sequences/:id/preview")
  @HttpCode(200)
  preview(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<{ steps: { position: number; subject: string; text: string; html: string }[] }> {
    const { contactId } = parse(PreviewInput, body ?? {});
    return this.sequences.preview(auth, id, contactId);
  }

  @Post("sequences/:id/enroll")
  @HttpCode(200)
  enroll(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<EnrollResultDto> {
    return this.enrollments.enroll(auth, id, parse(EnrollInputSchema, body));
  }

  /** Compliance and skip reasons per contact before enrolling (nothing is changed). */
  @Post("sequences/:id/enroll/preview")
  @HttpCode(200)
  enrollPreview(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<EnrollPreviewDto> {
    return this.enrollments.preview(auth, id, parse(EnrollPreviewInputSchema, body));
  }

  @Get("sequences/:id/enrollments")
  listEnrollments(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<{ items: EnrollmentDto[]; nextCursor: string | null }> {
    const q = parse(EnrollmentListQuery, query);
    return this.enrollments.list(auth, id, { ...q, cursor: q.cursor || undefined });
  }

  @Post("enrollments/:id/action")
  @HttpCode(200)
  act(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<EnrollmentDto> {
    const { action } = parse(EnrollmentActionInputSchema, body);
    return this.enrollments.act(auth, id, action);
  }

  @Get("contacts/:id/enrollments")
  contactEnrollments(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<EnrollmentDto[]> {
    return this.enrollments.forContact(auth, id);
  }

  @Get("contacts/:id/messages")
  contactMessages(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<MessageDto[]> {
    return this.enrollments.messagesForContact(auth, id);
  }
}
