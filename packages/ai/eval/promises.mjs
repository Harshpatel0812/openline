// Promise Keeper evaluation (OL-E6 §2): runs extraction over eval/promises.jsonl and reports
// recall (PRD goal: 90 %+ of commitments caught), false positives (goal: ≤ 10 %) and how often
// the resolved due date is right.
//
//   pnpm --filter @openline/ai eval:promises            # rule-based fallback (offline)
//   AI_PROVIDER=bedrock AWS_REGION=... AI_MODEL_SMALL=... AI_MODEL_LARGE=... \
//     pnpm --filter @openline/ai eval:promises          # Scout's small model
//
// For the development provider, set its API key variable (<PROVIDER>_API_KEY) as for the reply
// eval. Only ids, types and dates are printed — never the email text or the model's answers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ai = require("../dist/index.js");

const here = dirname(fileURLToPath(import.meta.url));
const out = (line = "") => process.stdout.write(`${line}\n`);

const kind = process.env.AI_PROVIDER ?? "rules";
const provider =
  kind === "rules" || kind === "off"
    ? null
    : ai.createProvider({
        provider: kind,
        models: {
          small: process.env.AI_MODEL_SMALL ?? "fake-small",
          large: process.env.AI_MODEL_LARGE ?? "fake-large",
        },
        region: process.env.AI_AWS_REGION ?? process.env.AWS_REGION,
        [`${kind}ApiKey`]: process.env[`${kind.toUpperCase()}_API_KEY`],
      });

const cases = readFileSync(join(here, "promises.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

let expectedTotal = 0;
let caught = 0;
let predictedTotal = 0;
let falsePositives = 0;
let negatives = 0;
let negativesFlagged = 0;
let datesChecked = 0;
let datesRight = 0;
let tokens = 0;
const misses = [];

for (const c of cases) {
  const input = {
    text: c.text,
    direction: c.direction,
    messageDate: new Date(c.messageDate),
    timeZone: c.timeZone,
  };
  let result;
  try {
    result = provider ? await ai.extractPromises(provider, input) : ai.rulePromises(input);
  } catch (err) {
    process.stderr.write(`${c.id}: ${err?.code ?? "error"} (fell back to rules)\n`);
    result = ai.rulePromises(input);
  }
  tokens += result.usage.inputTokens + result.usage.outputTokens;
  const predicted = result.promises.map((p) => ({
    type: p.type,
    due: ai.localDateOf(p.dueAt, c.timeZone),
  }));
  predictedTotal += predicted.length;
  expectedTotal += c.expected.length;
  if (!c.expected.length) {
    negatives += 1;
    if (predicted.length) negativesFlagged += 1;
  }

  const left = [...predicted];
  for (const e of c.expected) {
    // Prefer a prediction with the same type and date, then the same type.
    let i = left.findIndex((p) => p.type === e.type && p.due === e.due);
    if (i < 0) i = left.findIndex((p) => p.type === e.type);
    if (i < 0) {
      misses.push(`${c.id}: missed ${e.type}`);
      continue;
    }
    caught += 1;
    const [p] = left.splice(i, 1);
    if (e.due) {
      datesChecked += 1;
      if (p.due === e.due) datesRight += 1;
      else misses.push(`${c.id}: ${e.type} due ${p.due}, expected ${e.due}`);
    }
  }
  for (const p of left) {
    falsePositives += 1;
    misses.push(`${c.id}: unexpected ${p.type} (${p.due})`);
  }
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)} %` : "n/a");
out(
  `Extractor: ${provider ? provider.name : "rules"}   cases: ${cases.length}   tokens: ${tokens}`,
);
out(`Recall (commitments caught): ${pct(caught, expectedTotal)} (${caught}/${expectedTotal})`);
out(
  `False positives: ${pct(falsePositives, predictedTotal)} of proposals (${falsePositives}/${predictedTotal}); ` +
    `negatives flagged: ${negativesFlagged}/${negatives}`,
);
out(`Due dates right: ${pct(datesRight, datesChecked)} (${datesRight}/${datesChecked})`);
if (misses.length) {
  out();
  out("Differences:");
  for (const m of misses) out(`  ${m}`);
}
