/**
 * One-click unsubscribe headers (RFC 8058), required by Gmail and Yahoo for bulk senders.
 * Added to every outreach email. The HTTPS URL must accept a POST and unsubscribe immediately.
 */
export function buildUnsubscribeHeaders(httpsUrl: string, mailto?: string): Record<string, string> {
  const url = new URL(httpsUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  // Mailbox providers require https; plain http is accepted only for local development.
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Unsubscribe URL must use https");
  }
  const targets = [`<${url.toString()}>`];
  if (mailto) targets.push(`<mailto:${mailto}>`);

  return {
    "List-Unsubscribe": targets.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
