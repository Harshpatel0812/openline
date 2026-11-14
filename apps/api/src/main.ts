import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.setGlobalPrefix("v1", { exclude: ["health"] });

  // Basic security headers. Helmet + CORS allow-list are added in Sprint 1 (OL-E1).
  app.getHttpAdapter().getInstance().disable("x-powered-by");

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`Openline API listening on :${port}`);
}

void bootstrap();
