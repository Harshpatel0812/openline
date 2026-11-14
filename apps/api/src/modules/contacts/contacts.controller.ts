import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ContactCreateSchema,
  ContactListQuerySchema,
  ContactUpdateSchema,
  ImportCommitInputSchema,
  ImportPreviewInputSchema,
  type ContactDto,
  type ContactListDto,
  type ImportPreviewDto,
  type ImportResultDto,
} from "@openline/shared";
import { z } from "zod";
import { Auth, Roles, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { ContactsService } from "./contacts.service";
import { ImportService } from "./import.service";

const DeleteQuery = z.object({ suppress: z.enum(["true", "false"]).optional() });

@Controller("contacts")
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly imports: ImportService,
  ) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: unknown): Promise<ContactListDto> {
    const { q, limit, cursor } = parse(ContactListQuerySchema, query);
    return this.contacts.list(auth, { q: q || undefined, limit, cursor: cursor || undefined });
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body() body: unknown): Promise<ContactDto> {
    return this.contacts.create(auth, parse(ContactCreateSchema, body));
  }

  @Post("import/preview")
  @HttpCode(200)
  preview(@Auth() auth: AuthContext, @Body() body: unknown): Promise<ImportPreviewDto> {
    const { csv } = parse(ImportPreviewInputSchema, body);
    return this.imports.preview(auth, csv);
  }

  @Post("import")
  @HttpCode(200)
  commit(@Auth() auth: AuthContext, @Body() body: unknown): Promise<ImportResultDto> {
    const { csv, duplicates } = parse(ImportCommitInputSchema, body);
    return this.imports.commit(auth, csv, duplicates);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<ContactDto> {
    return this.contacts.get(auth, id);
  }

  @Patch(":id")
  update(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ContactDto> {
    return this.contacts.update(auth, id, parse(ContactUpdateSchema, body));
  }

  @Roles("owner", "admin", "manager")
  @Delete(":id")
  async remove(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<{ ok: true }> {
    const { suppress } = parse(DeleteQuery, query);
    await this.contacts.remove(auth, id, suppress === "true");
    return { ok: true };
  }
}
