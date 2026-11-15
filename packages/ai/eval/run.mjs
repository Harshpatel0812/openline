// Reply-classification evaluation (not part of CI): runs Scout's classifier over
// eval/replies.jsonl with the configured provider and reports accuracy (PRD goal: 90 %+).
//
//   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=... AI_MODEL_SMALL=... AI_MODEL_LARGE=... \
//     pnpm --filter @openline/ai eval
//   AI_PROVIDER=bedrock AWS_REGION=... AI_MODEL_SMALL=... AI_MODEL_LARGE=... pnpm --filter @openline/ai eval
//
// Only labels and counts are printed — never the email text or the model's answers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyReply, createProvider, REPLY_LABELS } = require("../dist/index.js");

const here = dirname(fileURLToPath(import.meta.url));
const out = (line = "") => process.stdout.write(`${line}\n`);

const provider = createProvider({
  provider: process.env.AI_PROVIDER ?? "fake",
  models: {
    small: process.env.AI_MODEL_SMALL ?? "fake-small",
    large: process.env.AI_MODEL_LARGE ?? "fake-large",
  },
  region: process.env.AI_AWS_REGION ?? process.env.AWS_REGION,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
});
if (!provider) {
  process.stderr.write("AI_PROVIDER is off — set bedrock, anthropic or fake.\n");
  process.exit(1);
}

const cases = readFileSync(join(here, "replies.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const confusion = Object.fromEntries(
  REPLY_LABELS.map((l) => [l, Object.fromEntries(REPLY_LABELS.map((m) => [m, 0]))]),
);
let correct = 0;
let invalid = 0;
let tokens = 0;
const misses = [];

for (const c of cases) {
  let label = "other";
  try {
    const res = await classifyReply(provider, { from: c.from, subject: c.subject, text: c.text });
    label = res.label;
    if (!res.valid) invalid += 1;
    tokens += res.usage.inputTokens + res.usage.outputTokens;
  } catch (err) {
    label = "other";
    invalid += 1;
    process.stderr.write(`${c.id}: ${err?.code ?? "error"}\n`);
  }
  confusion[c.label][label] += 1;
  if (label === c.label) correct += 1;
  else misses.push(`${c.id}: expected ${c.label}, got ${label}`);
}

out(`Provider: ${provider.name}   cases: ${cases.length}   tokens: ${tokens}`);
out(`Accuracy: ${((100 * correct) / cases.length).toFixed(1)} % (${correct}/${cases.length})`);
out(`Invalid answers (fell back to other): ${invalid}`);
out();
out("Per label (correct / total):");
for (const l of REPLY_LABELS) {
  const row = confusion[l];
  const total = Object.values(row).reduce((a, b) => a + b, 0);
  if (total) out(`  ${l.padEnd(15)} ${row[l]} / ${total}`);
}
if (misses.length) {
  out();
  out("Misses:");
  for (const m of misses) out(`  ${m}`);
}
