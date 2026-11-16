/** Labels and helpers for tasks and Promise Keeper (OL-E6 §1–2). */
import type { PromiseProposalDto, TaskDto, TaskKind } from "@openline/shared";

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  follow_up: "Follow up",
  send_promised: "Send what was promised",
  call: "Call",
  other: "Other",
};

/** Fired after a task or promise changes, so the sidebar badge and Today cards refresh. */
export const TASKS_CHANGED_EVENT = "openline:tasks-changed";

export function notifyTasksChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
}

export type TaskTab = "overdue" | "today" | "upcoming" | "done";
export const TASK_TABS: { id: TaskTab; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "done", label: "Done" },
];

/** The viewer's own IANA time zone (falls back to UTC). */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** "Mon, Nov 16, 9:00 AM EST" in the given time zone (the viewer's by default). */
export function formatInZone(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: timeZone ? safeZone(timeZone) : undefined,
  }).format(d);
}

/** Due-ness of an open task: overdue (red), due soon (amber) or neither. */
export function taskUrgency(t: Pick<TaskDto, "status" | "overdue" | "dueSoon">) {
  if (t.status !== "open") return null;
  if (t.overdue) return "overdue" as const;
  if (t.dueSoon) return "due_soon" as const;
  return null;
}

/** Local `YYYY-MM-DD` and `HH:MM` parts of an ISO time, for date and time inputs. */
export function toLocalParts(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * ISO time (UTC) from local date and time inputs. Empty date = no due date (null); a date
 * without a time means the end of the working day (17:00). Invalid input = undefined.
 */
export function fromLocalParts(date: string, time: string): string | null | undefined {
  if (!date) return null;
  const d = new Date(`${date}T${time || "17:00"}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "You promised", "They asked you to follow up", "They promised". */
export function promiseHeadline(p: Pick<PromiseProposalDto, "type">): string {
  switch (p.type) {
    case "our_promise":
      return "You promised";
    case "their_request":
      return "They asked you to follow up";
    case "their_promise":
      return "They promised";
  }
}

export function taskContactName(c: NonNullable<TaskDto["contact"]>): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.email;
}
