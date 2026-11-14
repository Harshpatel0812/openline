/**
 * Small RFC 4180 CSV reader for contact imports (no dependency; files are capped at 5 MB).
 * Handles: UTF-8 BOM, `,` `;` or tab delimiters (detected from the header line), quoted fields
 * with `""` escapes and embedded delimiters/line breaks, CRLF or LF line endings.
 */
import type { ImportField } from "@openline/shared";

export type Delimiter = "," | ";" | "\t";

export interface ParsedCsv {
  delimiter: Delimiter;
  header: string[];
  /** Data records (header excluded, fully empty lines skipped), cells trimmed. */
  rows: string[][];
}

const DELIMITERS: Delimiter[] = [",", ";", "\t"];

/** Picks the delimiter that occurs most often outside quotes on the first line. */
export function detectDelimiter(text: string): Delimiter {
  const counts = new Map<Delimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes; // a `""` escape toggles twice, which is a no-op
    } else if (!inQuotes && (ch === "\n" || ch === "\r")) {
      break;
    } else if (!inQuotes && counts.has(ch as Delimiter)) {
      counts.set(ch as Delimiter, counts.get(ch as Delimiter)! + 1);
    }
  }
  let best: Delimiter = ",";
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/** Splits CSV text into records of trimmed cells. */
export function parseCsv(input: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];

  let record: string[] = [];
  let cell = "";
  let inQuotes = false;
  const endCell = () => {
    record.push(cell.trim());
    cell = "";
  };
  const endRecord = () => {
    endCell();
    if (record.some((c) => c !== "")) records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRecord();
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || record.length > 0) endRecord();

  const [header = [], ...rows] = records;
  return { delimiter, header, rows };
}

// ------------------------------------------------------------------ header mapping

const SYNONYMS: Record<ImportField, string[]> = {
  email: ["email", "e-mail", "email address", "e-mail address", "work email"],
  firstName: ["first name", "firstname", "given name", "first"],
  lastName: ["last name", "lastname", "surname", "family name", "last"],
  title: ["title", "job title", "position", "role"],
  phone: ["phone", "phone number", "mobile", "telephone", "tel"],
  timeZone: ["time zone", "timezone", "tz"],
  country: ["country", "country code"],
  companyName: ["company", "company name", "organization", "organisation"],
  companyDomain: ["website", "domain", "company domain", "company website", "url"],
};

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[\s_-]+/g, "");

const LOOKUP = new Map<string, ImportField>();
for (const [field, names] of Object.entries(SYNONYMS) as [ImportField, string[]][]) {
  for (const name of names) LOOKUP.set(normalizeHeader(name), field);
}

/**
 * Maps each header to a contact field (case/space/underscore/hyphen-insensitive).
 * When two columns map to the same field, the first one wins and the rest are ignored.
 */
export function mapHeaders(header: string[]): (ImportField | null)[] {
  const used = new Set<ImportField>();
  return header.map((h) => {
    const field = LOOKUP.get(normalizeHeader(h)) ?? null;
    if (!field || used.has(field)) return null;
    used.add(field);
    return field;
  });
}

/** "https://www.Acme.com/about" → "acme.com". */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}
