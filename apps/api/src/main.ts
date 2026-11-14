import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureApp } from "./app.factory";
import { CONFIG, type AppConfig } from "./config";

async function bootstrap(): Promise<void> {
  const app = configureApp(
    await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false }),
  );
  const config = app.get<AppConfig>(CONFIG);
  await app.listen(config.API_PORT);
  console.log(`Openline API listening on :${config.API_PORT} (${config.NODE_ENV})`);
}

void bootstrap();
