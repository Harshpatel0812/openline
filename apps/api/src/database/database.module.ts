import { Global, Inject, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createDatabase, migrate, type DatabaseHandle } from "@openline/db";
import { CONFIG, loadConfig, type AppConfig } from "../config";

export const DB = Symbol("DB");

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    {
      provide: DB,
      inject: [CONFIG],
      useFactory: async (config: AppConfig): Promise<DatabaseHandle> => {
        const handle = createDatabase(config.DATABASE_URL);
        if (config.AUTO_MIGRATE) {
          const ran = await migrate(handle);
          if (ran.length) new Logger("Database").log(`Applied migrations: ${ran.join(", ")}`);
        }
        return handle;
      },
    },
  ],
  exports: [CONFIG, DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly handle: DatabaseHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}
