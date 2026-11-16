"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TaskDto } from "@openline/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  cx,
  LoadingBlock,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { TaskDialog } from "./task-dialog";
import {
  formatInZone,
  notifyTasksChanged,
  TASKS_CHANGED_EVENT,
  TASK_KIND_LABELS,
  taskContactName,
  taskUrgency,
} from "@/lib/tasks";

/** "Overdue" (red) or "Due soon" (amber) — always as words, never colour alone. */
export function TaskUrgencyBadge({
  task,
}: {
  task: Pick<TaskDto, "status" | "overdue" | "dueSoon">;
}) {
  const u = taskUrgency(task);
  if (u === "overdue") return <Badge tone="danger">Overdue</Badge>;
  if (u === "due_soon") return <Badge tone="warning">Due soon</Badge>;
  return null;
}

function TaskItem({
  task,
  showOwner,
  showContact,
  onChanged,
  onEdit,
}: {
  task: TaskDto;
  showOwner: boolean;
  showContact: boolean;
  onChanged: (t: TaskDto) => void;
  onEdit: (t: TaskDto) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"complete" | "dismiss" | "hide" | null>(null);
  const urgency = taskUrgency(task);
  const open = task.status === "open";

  async function run(kind: "complete" | "dismiss" | "hide") {
    setBusy(kind);
    try {
      const updated =
        kind === "hide"
          ? await api<TaskDto>(`/tasks/${task.id}`, {
              method: "PATCH",
              body: { suggestDone: false },
            })
          : await api<TaskDto>(`/tasks/${task.id}/${kind}`, { method: "POST" });
      onChanged(updated);
      notifyTasksChanged();
      if (kind !== "hide") {
        toast(kind === "complete" ? `Done: ${task.title}` : `Dismissed: ${task.title}`);
      }
    } catch (err) {
      toast(
        err instanceof ApiError && err.code === "task_closed"
          ? "This task was already closed."
          : errorMessage(err),
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <li
      className={cx(
        "flex flex-col gap-3 border-l-4 px-4 py-4 sm:flex-row sm:items-start sm:px-5",
        urgency === "overdue"
          ? "border-l-red-600 dark:border-l-red-400"
          : urgency === "due_soon"
            ? "border-l-amber-500 dark:border-l-amber-400"
            : "border-l-transparent",
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3
            className={cx(
              "text-sm font-medium break-words",
              open
                ? "text-slate-900 dark:text-slate-100"
                : "text-slate-600 line-through decoration-slate-400 dark:text-slate-400",
            )}
          >
            {task.title}
          </h3>
          <TaskUrgencyBadge task={task} />
          {task.source === "promise" ? <Badge tone="accent">From a promise</Badge> : null}
          {task.dueDateMissing && open ? <Badge>No date given</Badge> : null}
          {task.status === "dismissed" ? <Badge>Dismissed</Badge> : null}
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          {TASK_KIND_LABELS[task.kind]}
          {" · "}
          {open
            ? task.dueAt
              ? `Due ${formatInZone(task.dueAt)}`
              : "No due date"
            : task.completedAt
              ? `${task.status === "done" ? "Done" : "Closed"} ${formatInZone(task.completedAt)}`
              : "Closed"}
          {showOwner ? ` · ${task.owner.name}` : ""}
        </p>
        {showContact && task.contact ? (
          <Link
            href={`/app/contacts/${task.contact.id}`}
            className="inline-block rounded text-xs font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300"
          >
            {taskContactName(task.contact)}
          </Link>
        ) : null}
        {task.notes ? (
          <p className="text-sm whitespace-pre-wrap text-slate-700 dark:text-slate-300">
            {task.notes}
          </p>
        ) : null}
        {open && task.suggestDoneAt ? (
          <div className="mt-2 flex flex-col gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 sm:flex-row sm:items-center dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
            <p className="flex-1">
              Looks like you sent it ({formatInZone(task.suggestDoneAt)}) — mark done?
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                loading={busy === "complete"}
                disabled={busy !== null}
                onClick={() => void run("complete")}
                aria-label={`Yes, mark done — ${task.title}`}
              >
                Mark done
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === "hide"}
                disabled={busy !== null}
                onClick={() => void run("hide")}
                aria-label={`Not yet — ${task.title}`}
              >
                Not yet
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {open ? (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "complete" && !task.suggestDoneAt}
            disabled={busy !== null}
            onClick={() => void run("complete")}
            aria-label={`Complete — ${task.title}`}
          >
            Complete
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => onEdit(task)}
            aria-label={`Edit — ${task.title}`}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "dismiss"}
            disabled={busy !== null}
            onClick={() => void run("dismiss")}
            aria-label={`Dismiss — ${task.title}`}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function TaskList({
  tasks,
  showOwner = false,
  showContact = true,
  onChanged,
  onEdit,
  label,
}: {
  tasks: TaskDto[];
  showOwner?: boolean;
  showContact?: boolean;
  onChanged: (t: TaskDto) => void;
  onEdit: (t: TaskDto) => void;
  label: string;
}) {
  return (
    <ul aria-label={label} className="divide-y divide-slate-200 dark:divide-slate-800">
      {tasks.map((t) => (
        <TaskItem
          key={t.id}
          task={t}
          showOwner={showOwner}
          showContact={showContact}
          onChanged={onChanged}
          onEdit={onEdit}
        />
      ))}
    </ul>
  );
}

/** Open tasks for one contact (contact page), with "Add task". */
export function ContactTasksCard({
  contactId,
  contactName,
}: {
  contactId: string;
  contactName: string;
}) {
  const { data, error, loading, reload } = useResource<TaskDto[]>("/tasks", {
    contactId,
    status: "open",
    due: "any",
  });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TaskDto | null>(null);
  useEffect(() => {
    window.addEventListener(TASKS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, reload);
  }, [reload]);
  const overdue = (data ?? []).filter((t) => t.overdue).length;

  return (
    <Card>
      <CardHeader
        title="Tasks"
        description={
          overdue
            ? `${overdue} overdue — times are in your time zone.`
            : "Your open tasks for this contact. Times are in your time zone."
        }
        actions={
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            Add task
          </Button>
        }
      />
      {loading && !data ? (
        <LoadingBlock label="Loading tasks" />
      ) : error ? (
        <div className="space-y-2 p-5">
          <Alert tone="error">{errorMessage(error)}</Alert>
          <Button size="sm" variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : !data || data.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-600 dark:text-slate-400">No open tasks.</p>
      ) : (
        <TaskList
          label={`Open tasks for ${contactName}`}
          tasks={data}
          showContact={false}
          onChanged={() => reload()}
          onEdit={setEditing}
        />
      )}
      <TaskDialog
        open={creating || editing !== null}
        task={editing}
        fixedContact={{ id: contactId, name: contactName, email: "" }}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => reload()}
      />
    </Card>
  );
}
