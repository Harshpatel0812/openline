/** Scout (OL-E4 §4): error wording shared by every place that asks Scout for a draft. */
import { SCOUT_DRAFTS_PER_USER_PER_HOUR } from "@openline/shared";
import { ApiError, errorMessage } from "./api";
import { formatDay } from "./labels";

export interface ScoutProblem {
  title: string;
  body: string;
  /** Link to settings where the problem can be fixed, when there is one. */
  settingsLink?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function scoutErrorMessage(err: unknown): ScoutProblem {
  if (!(err instanceof ApiError)) {
    return { title: "Scout couldn't draft this", body: errorMessage(err) };
  }
  switch (err.code) {
    case "ai_unavailable":
      return {
        title: "Scout isn't available right now",
        body: "No AI model is reachable on this server. Try again in a few minutes — or, if it keeps happening, Scout may not be set up yet. You can still write the email yourself.",
      };
    case "scout_disabled":
      return {
        title: "Scout is turned off for this workspace",
        body: "An owner or admin can turn it on in Settings → Workspace → Scout.",
        settingsLink: true,
      };
    case "ai_budget_exceeded": {
      const resetsAt =
        isRecord(err.details) && typeof err.details.resetsAt === "string"
          ? err.details.resetsAt
          : null;
      return {
        title: "This month's Scout credits are used up",
        body: `${resetsAt ? `Credits reset on ${formatDay(resetsAt)}. ` : ""}An owner or admin can raise the monthly budget in Settings → Workspace → Scout.`,
        settingsLink: true,
      };
    }
    case "ai_invalid_output":
      return {
        title: "Scout's draft didn't pass our checks",
        body: "It made a claim it couldn't back with a source, or the answer was malformed, so we threw it away. Try again, or give a more specific purpose.",
      };
    case "rate_limited":
      return {
        title: "That's a lot of drafts",
        body: `Scout drafts up to ${SCOUT_DRAFTS_PER_USER_PER_HOUR} emails per person per hour. Please wait a little and try again.`,
      };
    case "invalid_transition":
      return {
        title: "This draft was already decided",
        body: "It was approved or rejected already. Ask Scout for a new draft if you need one.",
      };
    default:
      if (err.status === 429) {
        return {
          title: "Too many requests",
          body: "Please wait a minute and try again.",
        };
      }
      if (err.status === 404) {
        return {
          title: "Not found",
          body: "The contact or message is no longer available. Refresh the page and try again.",
        };
      }
      return { title: "Scout couldn't draft this", body: errorMessage(err) };
  }
}
