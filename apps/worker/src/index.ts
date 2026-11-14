import { Worker } from "bullmq";
import { QUEUES } from "@openline/shared";
import { handleSequenceSend } from "./jobs/sequence-send";

const connection = { url: process.env.REDIS_URL ?? "redis://localhost:6379" };

const workers = [
  new Worker(QUEUES.SEQUENCE_SEND, handleSequenceSend, { connection, concurrency: 10 }),
];

console.log(`Openline worker started: ${workers.map((w) => w.name).join(", ")}`);

async function shutdown(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
