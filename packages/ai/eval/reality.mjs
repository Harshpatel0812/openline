// Pipeline Reality Check evaluation (OL-E7 §4): runs evidence extraction over eval/reality.jsonl
// with the configured provider, then the deterministic assessDeal(), and reports how often the
// flags agree with a sales manager's judgment (PRD goal: 80 %+ of deals) and how often the
// evidence stage is right.
//
//   pnpm --filter @openline/ai eval:reality                     # fake provider (keyword rules)
//   AI_PROVIDER=bedrock AWS_REGION=... AI_MODEL_SMALL=... AI_MODEL_LARGE=... \
//     pnpm --filter @openline/ai eval:reality                   # Scout's small model
//
// For the development provider, set its API key variable (<PROVIDER>_API_KEY) as for the other
// evals. Only ids, flag codes and stage names are printed — never the email text or the model's
// answers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ai = require("../dist/index.js");

const here = dirname(fileURLToPath(import.meta.url));
const out = (line = "") => process.stdout.write(`${line}\n`);

const kind = process.env.AI_PROVIDER ?? "fake";
const provider = ai.createProvider({
  provider: kind,
  models: {
    small: process.env.AI_MODEL_SMALL ?? "fake-small",
    large: process.env.AI_MODEL_LARGE ?? "fake-large",
  },
  region: process.env.AI_AWS_REGION ?? process.env.AWS_REGION,
  [`${kind}ApiKey`]: process.env[`${kind.toUpperCase()}_API_KEY`],
});
if (!provider) {
  process.stderr.write("AI_PROVIDER is off — set it to a provider (see eval/run.mjs) or fake.\n");
  process.exit(1);
}

// The default stages (OL-E7 §1) with example entry criteria.
const STAGES = [
  ["Discovery", "open", 14, [["Replied with interest", "none"]]],
  [
    "Qualified",
    "open",
    14,
    [
      ["Need confirmed", "need_confirmed"],
      ["Decision maker involved", "decision_maker_engaged"],
    ],
  ],
  [
    "Proposal",
    "open",
    21,
    [
      ["Budget discussed", "budget_discussed"],
      ["Timeline agreed", "timeline_discussed"],
      ["Proposal sent", "proposal_sent"],
    ],
  ],
  ["Negotiation", "open", 14, [["Verbal yes", "verbal_yes"]]],
  ["Won", "won", null, []],
  ["Lost", "lost", null, []],
].map(([name, stageKind, staleAfterDays, criteria], i) => ({
  id: name.toLowerCase(),
  name,
  position: i + 1,
  kind: stageKind,
  staleAfterDays,
  entryCriteria: criteria.map(([label, evidence]) => ({ label, evidence })),
}));
const stageName = (id) => STAGES.find((s) => s.id === id)?.name ?? null;

const cases = readFileSync(join(here, "reality.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const key = (f) => (f.criterionKey ? `${f.code}:${f.criterionKey}` : f.code);
let agreed = 0;
let stagesRight = 0;
let stagesChecked = 0;
let tokens = 0;
let expectedFlags = 0;
let predictedFlags = 0;
let caughtFlags = 0;
const misses = [];

for (const c of cases) {
  const stage = STAGES.find((s) => s.name === c.deal.stage);
  const isOpen = stage.kind === "open";
  let evidence;
  if (isOpen) {
    try {
      const res = await ai.extractDealEvidence(provider, {
        deal: {
          name: c.deal.name,
          stageName: stage.name,
          nextStep: c.deal.nextStep,
          nextStepDate: c.deal.nextStepDate,
        },
        contacts: c.contacts,
        messages: c.messages,
      });
      tokens += res.usage.inputTokens + res.usage.outputTokens;
      if (!res.valid) process.stderr.write(`${c.id}: invalid model output (all unclear)\n`);
      evidence = res.evidence;
    } catch (err) {
      process.stderr.write(`${c.id}: ${err?.code ?? "error"} (deterministic flags only)\n`);
      tokens += (err?.details?.usage?.inputTokens ?? 0) + (err?.details?.usage?.outputTokens ?? 0);
    }
  }
  const result = ai.assessDeal(
    {
      stages: STAGES,
      deal: { ...c.deal, stageId: stage.id, isOpen },
      evidence,
      dismissedFlags: c.dismissedFlags,
      latestActivityAt: c.latestActivityAt,
      timeZone: c.timeZone,
    },
    new Date(c.now),
  );
  const predicted = result.flags.map(key).sort();
  const expected = [...c.expected.flags].sort();
  expectedFlags += expected.length;
  predictedFlags += predicted.length;
  caughtFlags += predicted.filter((f) => expected.includes(f)).length;
  const same = JSON.stringify(predicted) === JSON.stringify(expected);
  if (same) agreed += 1;
  else {
    const extra = predicted.filter((f) => !expected.includes(f));
    const missed = expected.filter((f) => !predicted.includes(f));
    misses.push(
      `${c.id}: ${missed.length ? `missed ${missed.join(", ")}` : ""}` +
        `${missed.length && extra.length ? "; " : ""}${extra.length ? `unexpected ${extra.join(", ")}` : ""}`,
    );
  }
  if (c.expected.evidenceStage !== null && evidence) {
    stagesChecked += 1;
    const got = stageName(result.evidenceStageId);
    if (got === c.expected.evidenceStage) stagesRight += 1;
    else misses.push(`${c.id}: evidence stage ${got}, expected ${c.expected.evidenceStage}`);
  }
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)} %` : "n/a");
out(`Provider: ${provider.name}   deals: ${cases.length}   tokens: ${tokens}`);
out(
  `Flags agree with the manager (whole deal): ${pct(agreed, cases.length)} (${agreed}/${cases.length})`,
);
out(
  `Flag recall: ${pct(caughtFlags, expectedFlags)} (${caughtFlags}/${expectedFlags}); ` +
    `precision: ${pct(caughtFlags, predictedFlags)} (${caughtFlags}/${predictedFlags})`,
);
out(`Evidence stage right: ${pct(stagesRight, stagesChecked)} (${stagesRight}/${stagesChecked})`);
if (misses.length) {
  out();
  out("Differences:");
  for (const m of misses) out(`  ${m}`);
}
