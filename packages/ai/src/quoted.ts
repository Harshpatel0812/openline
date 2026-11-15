/**
 * Quoted-history trimming shared by reply detection (packages/replies) and Promise Keeper's
 * rule-based fallback, so both cut an email at the same place.
 *
 * Every pattern is linear: line-anchored patterns use `[ \t]*`, never `\s*`, so a body of blank
 * lines can't make a multiline regex backtrack across newlines (security L5).
 */

const MARKERS: RegExp[] = [
  // "On … wrote:" and its translations; Gmail wraps long attribution lines over up to 4 lines.
  new RegExp(
    String.raw`^[ \t]*(?:On|Le|Am|El|Il|Op|Em|Den|Dne|W dniu)\b[^\n]{0,300}(?:\n[^\n]{0,300}){0,3}?(?:wrote|a écrit|schrieb|escribió|ha scritto|schreef|escreveu|skrev|napisał)[^\n:]{0,200}:[ \t]*$`,
    "m",
  ),
  /^[ \t]*-{2,}[ \t]*(?:Original Message|Ursprüngliche Nachricht|Originalnachricht|Mensaje original|Message d'origine|Messaggio originale|Oorspronkelijk bericht|Mensagem original)[ \t]*-{2,}/im,
  /^[ \t]*-{2,}[ \t]*(?:Forwarded message|Weitergeleitete Nachricht|Mensaje reenviado|Message transféré)[ \t]*-{2,}/im,
  /^[ \t]*_{10,}[ \t]*$/m,
  // Outlook header blocks: "From: … Sent: …" in English, German, Spanish, French, Italian, Dutch.
  /^[ \t]*\*?(?:From|Von|De|Da|Van):\*?[^\n]*\n(?:[^\n]*\n){0,3}?[ \t]*\*?(?:Sent|Date|Gesendet|Datum|Enviado|Fecha|Envoyé|Inviato|Verzonden|Data):\*?[ \t]/im,
];

/** Drops trailing spaces and tabs (a loop: `/[ \t]+$/` backtracks on long runs). */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end -= 1;
  return end === line.length ? line : line.slice(0, end);
}

/**
 * Cuts the quoted history: everything from "On … wrote:", "-----Original Message-----", an Outlook
 * "From: … Sent:" block or a "____" divider onwards, plus trailing "> " lines. Falls back to the
 * full text when the reply would be empty (someone answered inline). At most `maxChars` long.
 */
export function trimQuoted(input: string, maxChars = Number.POSITIVE_INFINITY): string {
  const text = input.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  let cut = text.length;
  for (const marker of MARKERS) {
    const m = marker.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const lines = text.slice(0, cut).split("\n");
  while (
    lines.length &&
    (/^\s*>/.test(lines[lines.length - 1]!) || !lines[lines.length - 1]!.trim())
  ) {
    lines.pop();
  }
  const trimmed = lines
    .map(trimLineEnd)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const result = trimmed || text.replace(/\n{3,}/g, "\n\n").trim();
  return result.slice(0, maxChars);
}
