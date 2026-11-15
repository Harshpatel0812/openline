/**
 * Template rendering for sequence emails.
 *
 * Authors write plain text with variables: {{firstName}}, {{lastName}}, {{fullName}}, {{email}},
 * {{company}}, {{title}}, {{senderName}}, with optional fallbacks: {{firstName|there}}.
 * Values are HTML-escaped in the HTML part, so contact data can never inject markup or links.
 * Unknown variables are reported (preview/validation) and rendered as empty text.
 */

export interface TemplateVars {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  company?: string | null;
  title?: string | null;
  senderName?: string | null;
}

export const TEMPLATE_VARIABLES = [
  "firstName",
  "lastName",
  "fullName",
  "email",
  "company",
  "title",
  "senderName",
] as const;

const VAR_PATTERN = /\{\{\s*([a-zA-Z]+)\s*(?:\|\s*([^}]{0,60}))?\}\}/g;

function valueFor(name: string, vars: TemplateVars): string | undefined {
  switch (name) {
    case "fullName":
      return [vars.firstName, vars.lastName].filter(Boolean).join(" ") || undefined;
    case "firstName":
    case "lastName":
    case "email":
    case "company":
    case "title":
    case "senderName":
      return vars[name] ?? undefined;
    default:
      return undefined;
  }
}

/** Variables used in a template that we don't know (shown as errors in the editor). */
export function unknownVariables(template: string): string[] {
  const unknown = new Set<string>();
  for (const match of template.matchAll(VAR_PATTERN)) {
    const name = match[1]!;
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) unknown.add(name);
  }
  return [...unknown];
}

export function renderText(template: string, vars: TemplateVars): string {
  return template.replace(VAR_PATTERN, (_, name: string, fallback?: string) => {
    const value = valueFor(name, vars)?.trim();
    return value ? value : (fallback?.trim() ?? "");
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text → simple HTML: escaped, paragraphs on blank lines, line breaks kept. */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** The footer's unsubscribe prompt; reply detection strips quoted copies of it before classifying. */
export const FOOTER_UNSUBSCRIBE_PROMPT = "Don't want to hear from us?";

export interface ComplianceFooter {
  /** CAN-SPAM: sender's valid physical postal address. */
  mailingAddress: string;
  /** One-click unsubscribe page. */
  unsubscribeUrl: string;
  senderCompany: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Renders subject and body and appends the legally required footer (sender identity, postal
 * address, unsubscribe link). Subjects are single-line (no header injection).
 */
export function renderEmail(
  subjectTemplate: string,
  bodyTemplate: string,
  vars: TemplateVars,
  footer: ComplianceFooter,
): RenderedEmail {
  const subject = renderText(subjectTemplate, vars)
    .replace(/[\r\n]+/g, " ")
    .trim();
  const body = renderText(bodyTemplate, vars);
  const footerText = `--\n${footer.senderCompany} · ${footer.mailingAddress}\n${FOOTER_UNSUBSCRIBE_PROMPT} Unsubscribe: ${footer.unsubscribeUrl}`;
  const footerHtml =
    `<p style="color:#64748b;font-size:12px;margin-top:24px">` +
    `${escapeHtml(footer.senderCompany)} · ${escapeHtml(footer.mailingAddress)}<br>` +
    `${FOOTER_UNSUBSCRIBE_PROMPT} <a href="${escapeHtml(footer.unsubscribeUrl)}">Unsubscribe</a></p>`;
  return {
    subject,
    text: `${body.trim()}\n\n${footerText}\n`,
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">\n${textToHtml(body)}\n${footerHtml}\n</body></html>`,
  };
}
