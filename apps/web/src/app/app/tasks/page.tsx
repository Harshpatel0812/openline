"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TaskCountsDto, TaskDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import { TaskDialog } from "@/components/app/task-dialog";
import { TaskList } from "@/components/app/task-list";
import { Alert, Button, Card, cx, EmptyState, LoadingBlock, Select } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { TASK_TABS, TASKS_CHANGED_EVENT, type TaskTab } from "@/lib/tasks";
import { useResource } from "@/lib/use-resource";

const EMPTY: Record<TaskTab, { title: string; description: string }> = {
  overdue: { title: "Nothing overdue", description: "Every open task is on time." },
  today: { title: "Nothing due today", description: "Tasks due later today show up here." },
  upcoming: {
    title: "Nothing coming up",
    description: "Tasks due after today, and tasks with no due date, show up here.",
  },
  done: { title: "No finished tasks yet", description: "Tasks you complete show up here." },
};

function isTab(v: string | null): v is TaskTab {
  return TASK_TABS.some((t) => t.id === v);
}

function TabPanelContent({
  tab,
  scope,
  onChanged,
  onEdit,
}: {
  tab: TaskTab;
  scope: "mine" | "all";
  onChanged: (t: TaskDto) => void;
  onEdit: (t: TaskDto) => void;
}) {
  const base = { scope };
  const main = useResource<TaskDto[]>("/tasks", {
    ...base,
    status: tab === "done" ? "done" : "open",
    due: tab === "done" ? "any" : tab,
  });
  // Upcoming also lists what's further out or undated: open tasks that aren't overdue, due today
  // or in the next 7 days.
  const today = useResource<TaskDto[]>(tab === "upcoming" ? "/tasks" : null, {
    ...base,
    due: "today",
  });
  const all = useResource<TaskDto[]>(tab === "upcoming" ? "/tasks" : null, {
    ...base,
    due: "any",
    limit: 200,
  });
  const reloadMain = main.reload;
  const reloadToday = today.reload;
  const reloadAll = all.reload;
  useEffect(() => {
    const bump = () => {
      reloadMain();
      reloadToday();
      reloadAll();
    };
    window.addEventListener(TASKS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, bump);
  }, [reloadMain, reloadToday, reloadAll]);

  const later = useMemo(() => {
    if (tab !== "upcoming" || !all.data || !today.data || !main.data) return [];
    const skip = new Set([...today.data, ...main.data].map((t) => t.id));
    return all.data.filter((t) => !t.overdue && !skip.has(t.id));
  }, [tab, all.data, today.data, main.data]);

  const loading =
    (main.loading && !main.data) ||
    (tab === "upcoming" && ((all.loading && !all.data) || (today.loading && !today.data)));
  const error = main.error ?? (tab === "upcoming" ? (all.error ?? today.error) : undefined);
  const showOwner = scope === "all";

  if (loading) return <LoadingBlock label="Loading tasks" />;
  if (error) {
    return (
      <div className="space-y-3 p-5">
        <Alert tone="error" title="Couldn't load tasks">
          {errorMessage(error)}
        </Alert>
        <Button
          variant="secondary"
          onClick={() => {
            main.reload();
            all.reload();
            today.reload();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  const items = main.data ?? [];
  if (items.length === 0 && later.length === 0) return <EmptyState {...EMPTY[tab]} />;

  return (
    <div className={cx(main.loading && "opacity-60")} aria-busy={main.loading}>
      {tab === "upcoming" ? (
        <>
          <h3 className="border-b border-slate-200 px-5 py-2 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:border-slate-800 dark:text-slate-400">
            Next 7 days
          </h3>
          {items.length ? (
            <TaskList
              label="Due in the next 7 days"
              tasks={items}
              showOwner={showOwner}
              onChanged={onChanged}
              onEdit={onEdit}
            />
          ) : (
            <p className="px-5 py-4 text-sm text-slate-600 dark:text-slate-400">
              Nothing due in the next 7 days.
            </p>
          )}
          {later.length ? (
            <>
              <h3 className="border-y border-slate-200 px-5 py-2 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:border-slate-800 dark:text-slate-400">
                Later or no due date
              </h3>
              <TaskList
                label="Later or no due date"
                tasks={later}
                showOwner={showOwner}
                onChanged={onChanged}
                onEdit={onEdit}
              />
            </>
          ) : null}
        </>
      ) : (
        <TaskList
          label={TASK_TABS.find((t) => t.id === tab)?.label ?? "Tasks"}
          tasks={items}
          showOwner={showOwner}
          onChanged={onChanged}
          onEdit={onEdit}
        />
      )}
    </div>
  );
}

function TasksView() {
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const isManager = can("owner", "admin", "manager");
  const rawTab = params.get("tab");
  const tab: TaskTab = isTab(rawTab) ? rawTab : "today";
  const scope = isManager && params.get("scope") === "all" ? "all" : "mine";
  const counts = useResource<TaskCountsDto>("/tasks/counts");
  const [editing, setEditing] = useState<TaskDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [live, setLive] = useState("");
  const tabRefs = useRef(new Map<TaskTab, HTMLButtonElement>());
  const baseId = useId();
  const scopeId = useId();
  const reloadCounts = counts.reload;

  useEffect(() => {
    window.addEventListener(TASKS_CHANGED_EVENT, reloadCounts);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, reloadCounts);
  }, [reloadCounts]);

  function go(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % TASK_TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TASK_TABS.length) % TASK_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TASK_TABS.length - 1;
    else return;
    e.preventDefault();
    const id = TASK_TABS[next]!.id;
    go({ tab: id });
    tabRefs.current.get(id)?.focus();
  }

  const countFor = (t: TaskTab) =>
    scope !== "mine" || !counts.data
      ? undefined
      : t === "overdue"
        ? counts.data.overdue
        : t === "today"
          ? counts.data.dueToday
          : t === "upcoming"
            ? counts.data.upcoming
            : undefined;

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Follow-ups and promises, by when they're due. Times are in your time zone."
        actions={<Button onClick={() => setCreating(true)}>New task</Button>}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-200 px-3 pt-3 sm:flex-row sm:items-end sm:justify-between sm:px-5 dark:border-slate-800">
          <div
            role="tablist"
            aria-label="Tasks by due date"
            className="-mb-px flex gap-1 overflow-x-auto"
          >
            {TASK_TABS.map((t, i) => {
              const selected = t.id === tab;
              const n = countFor(t.id);
              return (
                <button
                  key={t.id}
                  ref={(el) => {
                    if (el) tabRefs.current.set(t.id, el);
                  }}
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${t.id}`}
                  aria-selected={selected}
                  aria-controls={`${baseId}-panel`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => go({ tab: t.id })}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={cx(
                    "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none",
                    selected
                      ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
                      : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white",
                  )}
                >
                  {t.label}
                  {n !== undefined ? (
                    <span
                      className={cx(
                        "rounded-full px-1.5 text-xs font-semibold",
                        t.id === "overdue" && n > 0
                          ? "bg-red-600 text-white dark:bg-red-500"
                          : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
                      )}
                    >
                      {n}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {isManager ? (
            <div className="flex items-center gap-2 pb-2">
              <label htmlFor={scopeId} className="text-sm text-slate-700 dark:text-slate-300">
                Show
              </label>
              <Select
                id={scopeId}
                value={scope}
                onChange={(e) => go({ scope: e.target.value === "all" ? "all" : null })}
                className="h-9 w-auto"
              >
                <option value="mine">My tasks</option>
                <option value="all">Everyone&apos;s tasks</option>
              </Select>
            </div>
          ) : null}
        </div>
        <div
          role="tabpanel"
          id={`${baseId}-panel`}
          aria-labelledby={`${baseId}-tab-${tab}`}
          tabIndex={0}
          className="focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none"
        >
          <TabPanelContent
            key={`${tab}-${scope}`}
            tab={tab}
            scope={scope}
            onChanged={(t) =>
              setLive(
                t.status === "done"
                  ? `Completed ${t.title}.`
                  : t.status === "dismissed"
                    ? `Dismissed ${t.title}.`
                    : `Updated ${t.title}.`,
              )
            }
            onEdit={setEditing}
          />
        </div>
      </Card>

      <TaskDialog
        open={creating || editing !== null}
        task={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={(t) => setLive(editing ? `Saved ${t.title}.` : `Created ${t.title}.`)}
      />
    </>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading tasks" />}>
      <TasksView />
    </Suspense>
  );
}
