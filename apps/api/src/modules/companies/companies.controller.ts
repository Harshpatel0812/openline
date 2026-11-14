import { Controller, Get, Query } from "@nestjs/common";
import type { CompanyDto } from "@openline/shared";
import { z } from "zod";
import { Auth, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { CompaniesService } from "./companies.service";

const CompanyQuery = z.object({ q: z.string().trim().max(200).optional() });

@Controller("companies")
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: unknown): Promise<{ items: CompanyDto[] }> {
    const { q } = parse(CompanyQuery, query);
    return this.companies.list(auth, q || undefined);
  }
}
