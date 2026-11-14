/**
 * Open tracking is unreliable: security scanners and privacy proxies "open" emails automatically.
 * We flag those opens as bots and leave them out of stats. This method is published on our site.
 */
const SCANNER_USER_AGENT_PATTERNS = [
  /barracuda/i,
  /mimecast/i,
  /proofpoint/i,
  /symantec/i,
  /microsoft office protection/i,
  /googleimageproxy/i, // Gmail image proxy pre-fetch
];

/** Opens faster than a human could plausibly read are treated as automated. */
export const MIN_HUMAN_OPEN_DELAY_MS = 2_000;

export function isLikelyBotOpen(input: {
  deliveredAt: Date;
  openedAt: Date;
  userAgent?: string;
}): boolean {
  const delay = input.openedAt.getTime() - input.deliveredAt.getTime();
  if (delay < MIN_HUMAN_OPEN_DELAY_MS) return true;
  const ua = input.userAgent ?? "";
  return SCANNER_USER_AGENT_PATTERNS.some((pattern) => pattern.test(ua));
}
