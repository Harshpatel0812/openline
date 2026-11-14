/** Background job queues. Names are part of the contract between api and worker. */
export const QUEUES = {
  SEQUENCE_SEND: "sequence-send",
  REPLY_SYNC: "reply-sync",
  AI: "ai",
  CALLS: "calls",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Workspace roles, from most to least privileged. Checked in the API, never only in the UI. */
export const ROLES = ["owner", "admin", "manager", "rep"] as const;
export type Role = (typeof ROLES)[number];

/** Safe defaults for cold outreach. Plans can raise these; nothing can remove them. */
export const SENDING_DEFAULTS = {
  /** Cold emails per connected mailbox per day before warm-up raises it. */
  dailyCapPerMailbox: 50,
  /** Random spacing between sends from one mailbox, in seconds. */
  minSpacingSeconds: 60,
  maxSpacingSeconds: 300,
  /** Pause a mailbox when its 24h bounce rate exceeds this share. */
  bounceRatePauseThreshold: 0.03,
} as const;
