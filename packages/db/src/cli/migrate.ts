import { createDatabase } from "../client";
import { migrate } from "../migrate";

/** `pnpm --filter @openline/db db:migrate` — applies pending migrations to DATABASE_URL. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const handle = createDatabase(url);
  try {
    const ran = await migrate(handle);
    console.warn(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date.");
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
