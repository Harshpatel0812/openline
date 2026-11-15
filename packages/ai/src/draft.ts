/**
 * Scout drafting (large model): a first-touch email for a sequence step, or a reply to an inbound
 * message. Rule "cite or stay silent": every specific claim about the prospect must cite a
 * source that was actually in the input (a contact field id such as `contact.title`, a fetched
 * page URL, or the inbound message). Citations to anything else are dropped; if the body still
 * makes such a claim, the output is invalid (retried once, then AiError("invalid_output")).
 *
 * Contact fields, page text and inbound emails are fenced as untrusted data. Drafts are only
 * proposals: the caller stores them as `proposed` ai_actions for a human to approve.
 */
import { TEMPLATE_VARIABLES } from "@openline/email";
import { z } from "zod";
import { parseModelJson } from "./json";
import {
  addUsage,
  AiError,
  failedWithUsage,
  ZERO_USAGE,
  type LlmProvider,
  type LlmUsage,
} from "./provider";
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "./untrusted";

export interface DraftContact {
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  company?: string | null;
  companyDomain?: string | null;
  country?: string | null;
}

export interface WebPage {
  url: string;
  title?: string;
  text: string;
}

/** Something the model may cite. `id` is what citations must use. */
export interface DraftSource {
  id: string;
  kind: "contact_field" | "web_page" | "message";
  label: string;
}

export interface Citation {
  claim: string;
  source: string;
}

export interface DraftResult {
  subject?: string;
  body: string;
  citations: Citation[];
  /** Every source that was given to the model (shown in the UI next to the citations). */
  sources: DraftSource[];
  usage: LlmUsage;
  model: string;
}

export interface WorkspaceVoice {
  aboutUs?: string | null;
  valueProposition?: string | null;
  senderName?: string | null;
}

export interface FirstTouchInput extends WorkspaceVoice {
  contact: DraftContact;
  /** The rep's one-line note on what this email is for. */
  purpose: string;
  pages?: WebPage[];
}

export interface ReplyDraftInput extends WorkspaceVoice {
  thread: { text: string; subject: string; from: string };
  contact: DraftContact;
  originalStep?: { subject: string; body: string } | null;
  /** Optional extra instruction from the rep. */
  instructions?: string | null;
}

export const DRAFT_LIMITS = {
  subject: 200,
  body: 5_000,
  citations: 20,
  pageChars: 6_000,
  threadChars: 8_000,
} as const;

const CONTACT_FIELDS: { key: keyof DraftContact; id: string; label: string }[] = [
  { key: "firstName", id: "contact.firstName", label: "First name" },
  { key: "lastName", id: "contact.lastName", label: "Last name" },
  { key: "title", id: "contact.title", label: "Job title" },
  { key: "company", id: "contact.company", label: "Company" },
  { key: "companyDomain", id: "company.domain", label: "Company domain" },
  { key: "country", id: "contact.country", label: "Country" },
];

export const INBOUND_MESSAGE_SOURCE = "message.inbound";

const RawDraftSchema = z.object({
  subject: z.string().max(DRAFT_LIMITS.subject).nullish(),
  body: z.string().trim().min(1).max(DRAFT_LIMITS.body),
  citations: z
    .array(
      z.object({ claim: z.string().trim().min(1).max(500), source: z.string().trim().max(2048) }),
    )
    .max(DRAFT_LIMITS.citations)
    .default([]),
});

const draftJsonSchema = (withSubject: boolean) => ({
  type: "object",
  required: withSubject ? ["subject", "body", "citations"] : ["body", "citations"],
  properties: {
    ...(withSubject ? { subject: { type: "string", maxLength: DRAFT_LIMITS.subject } } : {}),
    body: { type: "string", maxLength: DRAFT_LIMITS.body },
    citations: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "source"],
        properties: { claim: { type: "string" }, source: { type: "string" } },
      },
    },
  },
});

const VARIABLE_LIST = TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ");

const COMMON_RULES = [
  UNTRUSTED_DATA_RULE,
  "Cite or stay silent: every specific fact about the prospect, their company or what they said " +
    "must come from the data provided and be listed in `citations` as {claim, source}. `claim` " +
    "is the exact sentence or phrase from your text; `source` is one id from 'Allowed citation " +
    "sources', copied exactly. If no source supports a fact, leave the fact out.",
  "Claims about our own company may only use the 'About us' and 'Value proposition' text.",
  "Plain text only: no HTML, no markdown, no links, no attachments, no prices or discounts " +
    "unless the rep's note gives them. Do not add an unsubscribe line or postal address (Openline " +
    "adds the legal footer).",
];

export const FIRST_TOUCH_SYSTEM_PROMPT = [
  "You draft the first email of a B2B outreach sequence for a sales rep. A human reviews every " +
    "draft before anything is sent.",
  ...COMMON_RULES,
  `Personalisation variables: where personalisation is generic, use ${VARIABLE_LIST} ` +
    "(fallbacks allowed, e.g. {{firstName|there}}). No other {{...}} variables.",
  "Keep it under 120 words, one clear ask, a short specific subject line. Sign off with " +
    "{{senderName}}.",
].join("\n");

export const REPLY_SYSTEM_PROMPT = [
  "You draft a reply to a prospect's email for a sales rep. A human reviews every draft before " +
    "anything is sent.",
  ...COMMON_RULES,
  "The rep sends this reply directly: write real names, never {{...}} template variables.",
  "Answer what the prospect actually asked; keep it under 150 words; no subject line.",
].join("\n");

function contactSources(contact: DraftContact): { sources: DraftSource[]; data: string } {
  const sources: DraftSource[] = [];
  const data: Record<string, string> = {};
  for (const f of CONTACT_FIELDS) {
    const value = contact[f.key]?.trim();
    if (!value) continue;
    sources.push({ id: f.id, kind: "contact_field", label: f.label });
    data[f.id] = value.slice(0, 300);
  }
  return { sources, data: JSON.stringify(data, null, 2) };
}

function workspaceSection(voice: WorkspaceVoice): string {
  return [
    `About us: ${voice.aboutUs?.trim() || "(not provided)"}`,
    `Value proposition: ${voice.valueProposition?.trim() || "(not provided)"}`,
    `Sender name: ${voice.senderName?.trim() || "(use {{senderName}})"}`,
  ].join("\n");
}

function sourcesSection(sources: DraftSource[]): string {
  if (!sources.length) return "Allowed citation sources: none — make no specific claims.\n";
  return `Allowed citation sources (cite these ids exactly):\n${sources
    .map((s) => `- ${s.id}`)
    .join("\n")}\n`;
}

export function buildFirstTouchPrompt(input: FirstTouchInput): {
  prompt: string;
  sources: DraftSource[];
} {
  const contact = contactSources(input.contact);
  const pages = (input.pages ?? []).slice(0, 3);
  const sources: DraftSource[] = [
    ...contact.sources,
    ...pages.map((p) => ({ id: p.url, kind: "web_page" as const, label: p.title || p.url })),
  ];
  const parts = [
    "Write the first email of the sequence.",
    `Purpose (from the rep): ${input.purpose.trim().slice(0, 500)}`,
    workspaceSection(input),
    sourcesSection(sources),
    "Contact record (keys are source ids):",
    wrapUntrusted("crm:contact", contact.data).text,
    ...pages.map(
      (p) =>
        `Web page ${p.url}:\n${wrapUntrusted(`web:${p.url}`, p.text.slice(0, DRAFT_LIMITS.pageChars)).text}`,
    ),
  ];
  return { prompt: parts.join("\n\n"), sources };
}

export function buildReplyPrompt(input: ReplyDraftInput): {
  prompt: string;
  sources: DraftSource[];
} {
  const contact = contactSources(input.contact);
  const sources: DraftSource[] = [
    ...contact.sources,
    { id: INBOUND_MESSAGE_SOURCE, kind: "message", label: "Their email" },
  ];
  const parts = [
    "Write a reply to the prospect's email below.",
    input.instructions?.trim()
      ? `Instructions from the rep: ${input.instructions.trim().slice(0, 500)}`
      : "",
    workspaceSection(input),
    sourcesSection(sources),
    "Contact record (keys are source ids):",
    wrapUntrusted("crm:contact", contact.data).text,
    input.originalStep
      ? `The email of ours they replied to (written by the rep):\nSubject: ${input.originalStep.subject}\n${input.originalStep.body.slice(0, 3000)}`
      : "",
    `Their email (source id ${INBOUND_MESSAGE_SOURCE}):`,
    wrapUntrusted(
      "email:inbound",
      `From: ${input.thread.from}\nSubject: ${input.thread.subject}\n\n${input.thread.text.slice(0, DRAFT_LIMITS.threadChars)}`,
    ).text,
  ].filter(Boolean);
  return { prompt: parts.join("\n\n"), sources };
}

// Same grammar as packages/email render.ts.
const VAR_PATTERN = /\{\{\s*([a-zA-Z]+)\s*(?:\|\s*([^}]{0,60}))?\}\}/g;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeSource(id: string): string {
  return id.trim().replace(/\/+$/, "");
}

export type DraftValidation =
  | { ok: true; subject?: string; body: string; citations: Citation[] }
  | { ok: false; reason: string };

/**
 * Checks a model answer: shape, template variables, and that every cited source was in the
 * input. Any citation of a source that wasn't provided rejects the whole draft (the caller retries
 * once, then reports invalid output).
 */
export function validateDraft(
  text: string,
  allowed: DraftSource[],
  opts: { subject: boolean; variables: boolean },
): DraftValidation {
  const raw = parseModelJson(RawDraftSchema, text);
  if (!raw) return { ok: false, reason: "shape" };
  const subject = raw.subject?.replace(/[\r\n]+/g, " ").trim() || undefined;
  if (opts.subject && !subject) return { ok: false, reason: "missing_subject" };

  const content = `${subject ?? ""}\n${raw.body}`;
  if (opts.variables) {
    const known = TEMPLATE_VARIABLES as readonly string[];
    for (const m of content.matchAll(VAR_PATTERN)) {
      if (!known.includes(m[1]!)) return { ok: false, reason: "unknown_variable" };
    }
    if (/\{\{|\}\}/.test(content.replace(VAR_PATTERN, ""))) {
      return { ok: false, reason: "malformed_variable" };
    }
  } else if (/\{\{|\}\}/.test(content)) {
    return { ok: false, reason: "variables_not_allowed" };
  }

  const allowedIds = new Set(allowed.map((s) => normalizeSource(s.id)));
  const byId = new Map(allowed.map((s) => [normalizeSource(s.id), s.id]));
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const c of raw.citations) {
    const id = normalizeSource(c.source);
    // Citing anything we never gave it means the model is working from outside knowledge (or an
    // injected instruction): the whole answer is invalid, whether or not the text uses the claim.
    if (!allowedIds.has(id)) return { ok: false, reason: "unsupported_claim" };
    const key = `${normalize(c.claim)}|${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ claim: c.claim, source: byId.get(id)! });
  }
  return { ok: true, subject: opts.subject ? subject : undefined, body: raw.body, citations };
}

async function runDraft(
  provider: LlmProvider,
  system: string,
  prompt: string,
  sources: DraftSource[],
  opts: { subject: boolean; variables: boolean },
): Promise<DraftResult> {
  let usage = ZERO_USAGE;
  let model = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await provider.complete({
        system,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 1_200,
        model: "large",
        jsonSchema: draftJsonSchema(opts.subject),
      });
    } catch (error) {
      // Keep what earlier attempts spent: it still counts to the budget.
      throw failedWithUsage(error, usage, model);
    }
    usage = addUsage(usage, res.usage);
    model = res.model;
    const checked = validateDraft(res.text, sources, opts);
    if (checked.ok) {
      return {
        ...(checked.subject ? { subject: checked.subject } : {}),
        body: checked.body,
        citations: checked.citations,
        sources,
        usage,
        model,
      };
    }
  }
  throw new AiError("invalid_output", "Scout couldn't write a draft it can back up. Try again.", {
    usage,
    model,
  });
}

export function draftFirstTouch(
  provider: LlmProvider,
  input: FirstTouchInput,
): Promise<DraftResult> {
  const { prompt, sources } = buildFirstTouchPrompt(input);
  return runDraft(provider, FIRST_TOUCH_SYSTEM_PROMPT, prompt, sources, {
    subject: true,
    variables: true,
  });
}

export function draftReply(provider: LlmProvider, input: ReplyDraftInput): Promise<DraftResult> {
  const { prompt, sources } = buildReplyPrompt(input);
  return runDraft(provider, REPLY_SYSTEM_PROMPT, prompt, sources, {
    subject: false,
    variables: false,
  });
}
