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
  CreateTaskInputSchema,
  TaskQuerySchema,
  UpdateTaskInputSchema,
  type TaskCountsDto,
  type TaskDto,
} from "@openline/shared";
import { Auth, type AuthContext } from "../../common/auth-context";
import { parse } from "../../common/http";
import { TasksService } from "./tasks.service";

/** Tasks (OL-E6 §1). All roles; reps see and edit their own, managers+ everyone's (service). */
@Controller("tasks")
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: unknown): Promise<TaskDto[]> {
    return this.tasks.list(auth, parse(TaskQuerySchema, query));
  }

  @Get("counts")
  counts(@Auth() auth: AuthContext): Promise<TaskCountsDto> {
    return this.tasks.counts(auth);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<TaskDto> {
    return this.tasks.get(auth, id);
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body() body: unknown): Promise<TaskDto> {
    return this.tasks.create(auth, parse(CreateTaskInputSchema, body));
  }

  @Patch(":id")
  update(
    @Auth() auth: AuthContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<TaskDto> {
    return this.tasks.update(auth, id, parse(UpdateTaskInputSchema, body));
  }

  @Post(":id/complete")
  @HttpCode(200)
  complete(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<TaskDto> {
    return this.tasks.close(auth, id, "done");
  }

  @Post(":id/dismiss")
  @HttpCode(200)
  dismiss(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string): Promise<TaskDto> {
    return this.tasks.close(auth, id, "dismissed");
  }
}
