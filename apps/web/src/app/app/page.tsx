"use client";

import Link from "next/link";
import { useEffect } from "react";
import type {
  ContactListDto,
  InboxCountsDto,
  MailboxDto,
  SequenceDto,
  TaskCountsDto,
  TaskDto,
  WorkspaceSettingsDto,
} from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import { PromisesPanel } from "@/components/app/promises";
import { TaskUrgencyBadge } from "@/components/app/task-list";
import { Alert, Button, Card, CardHeader, cx, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { REPLY_LABEL_TEXT } from "@/lib/inbox";
import { formatInZone, TASKS_CHANGED_EVENT, taskContactName, type TaskTab } from "@/lib/tasks";
import { useResource } from "@/lib/use-resource";

interface Step {
  title: string;
  body: string;
  href: string;
  cta: string;
  /** undefined = still loading (or couldn't tell). */
  done: boolean | undefined;
}

/** Done-ness from a resource: unknown while loading; treated as "to do" if it failed to load. */
function check<T>(r: { data: T | undefined; error: unknown }, test: (d: T) => boolean) {
  if (r.data !== undefined) return test(r.data);
  return r.error ? false : undefined;
}

function enrolledCount(s: SequenceDto): number {
  const t = s.stats;
  return t.active + t.completed + t.replied + t.unsubscribed + t.bounced + t.stopped + t.error;
}

function RepliesCard() {
  const counts = useResource<InboxCountsDto>("/inbox/counts");
  const n = counts.data?.needsAction;
  const breakdown = counts.data
    ? (["interested", "referral", "not_now", "other"] as const)
        .filter((l) => (counts.data?.byLabel[l] ?? 0) > 0)
        .map((l) => `${counts.data?.byLabel[l]} ${REPLY_LABEL_TEXT[l].toLowerCase()}`)
        .join(" · ")
    : "";
  return (
    <Card>
      <CardHeader as="h2" title="Replies needing action" />
      <div className="px-5 py-4">
        {counts.loading && !counts.data ? (
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <Spinner size="sm" label="" /> Checking the inbox…
          </div>
        ) : counts.error ? (
          <Alert tone="error">{errorMessage(counts.error)}</Alert>
        ) : (
          <>
            <p className="text-3xl font-semibold text-slate-900 dark:text-white">{n ?? 0}</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {n ? breakdown : "You're all caught up."}
            </p>
            <Link
              href="/app/inbox"
              className="mt-3 inline-block rounded text-sm font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-400"
            >
              {n ? "Open the inbox" : "See all replies"} →
            </Link>
          </>
        )}
      </div>
    </Card>
  );
}

/** Tasks listed on each Today card. */
const LIST_LIMIT = 3;

const TASK_CARDS: {
  tab: TaskTab;
  due: "overdue" | "today" | "upcoming";
  title: string;
  count: keyof TaskCountsDto;
  empty: string;
}[] = [
  { tab: "overdue", due: "overdue", title: "Overdue", count: "overdue", empty: "Nothing overdue." },
  {
    tab: "today",
    due: "today",
    title: "Due today",
    count: "dueToday",
    empty: "Nothing due today.",
  },
  {
    tab: "upcoming",
    due: "upcoming",
    title: "Next 7 days",
    count: "upcoming",
    empty: "Nothing in the next 7 days.",
  },
];

function TaskSummaryCard({
  card,
  counts,
}: {
  card: (typeof TASK_CARDS)[number];
  counts: { data: TaskCountsDto | undefined; loading: boolean; error: unknown };
}) {
  const list = useResource<TaskDto[]>("/tasks", { due: card.due, limit: LIST_LIMIT });
  const reload = list.reload;
  useEffect(() => {
    window.addEventListener(TASKS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, reload);
  }, [reload]);
  // The card has one loading state: it ends as soon as either request answers, so a card whose
  // tasks are on screen never still says "Loading…". Until the counts arrive, a short list (fewer
  // than the 3 shown) is its own exact count; a full one shows "3+".
  const shown = list.data?.length;
  const n =
    counts.data?.[card.count] ?? (shown !== undefined && shown < LIST_LIMIT ? shown : undefined);
  const loading = !counts.data && !counts.error && !list.data && !list.error;
  const urgent = card.tab === "overdue" && (n ?? shown ?? 0) > 0;
  return (
    <Card
      className={cx(urgent && "border-red-300 dark:border-red-800")}
      aria-labelledby={`today-${card.tab}`}
      aria-busy={loading}
      role="region"
    >
      <div className="px-5 py-4">
        <h2
          id={`today-${card.tab}`}
          className="text-sm font-semibold text-slate-700 dark:text-slate-300"
        >
          {card.title}
        </h2>
        {loading ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <Spinner size="sm" label="" /> Loading…
          </p>
        ) : n !== undefined || shown !== undefined ? (
          <p
            className={cx(
              "mt-1 text-3xl font-semibold",
              urgent ? "text-red-700 dark:text-red-400" : "text-slate-900 dark:text-white",
            )}
          >
            {n ?? `${shown ?? 0}+`}
            <span className="sr-only"> tasks</span>
          </p>
        ) : counts.error ? (
          <p className="mt-2 text-sm text-red-700 dark:text-red-400">
            {errorMessage(counts.error)}
          </p>
        ) : null}
        {loading ? null : list.data && list.data.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {list.data.map((t) => (
              <li key={t.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium break-words text-slate-900 dark:text-slate-100">
                    {t.title}
                  </span>
                  <TaskUrgencyBadge task={t} />
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  {t.dueAt ? formatInZone(t.dueAt) : "No due date"}
                  {t.contact ? ` · ${taskContactName(t.contact)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : list.data || n === 0 ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{card.empty}</p>
        ) : list.error ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Couldn&apos;t load these tasks just now.
          </p>
        ) : null}
        <Link
          href={`/app/tasks?tab=${card.tab}`}
          className="mt-3 inline-block rounded text-sm font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-400"
        >
          See {card.title.toLowerCase()}
          <span aria-hidden="true"> →</span>
        </Link>
      </div>
    </Card>
  );
}

function TasksToday() {
  const counts = useResource<TaskCountsDto>("/tasks/counts");
  const reload = counts.reload;
  useEffect(() => {
    window.addEventListener(TASKS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, reload);
  }, [reload]);
  return (
    <section aria-labelledby="today-tasks" className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="today-tasks" className="text-lg font-semibold text-slate-900 dark:text-white">
          Your tasks
        </h2>
        <Link
          href="/app/tasks"
          className="rounded text-sm font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-400"
        >
          All tasks
        </Link>
      </div>
      {counts.error ? (
        <div className="mb-3 flex items-center gap-3">
          <Button size="sm" variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        {TASK_CARDS.map((c) => (
          <TaskSummaryCard key={c.tab} card={c} counts={counts} />
        ))}
      </div>
    </section>
  );
}

export default function TodayPage() {
  const { me } = useMe();
  const workspace = useResource<WorkspaceSettingsDto>("/workspace");
  const mailboxes = useResource<MailboxDto[]>("/mailboxes");
  const contacts = useResource<ContactListDto>("/contacts", { limit: 1 });
  const sequences = useResource<SequenceDto[]>("/sequences", { includeArchived: "true" });
  const firstName = me.user.name.split(" ")[0] || me.user.name;

  const steps: Step[] = [
    {
      title: "Verify your email",
      body: `Click the link we sent to ${me.user.email}. Needed before you can send.`,
      href: "/app",
      cta: "Use “Resend email” in the banner above",
      done: me.user.emailVerified,
    },
    {
      title: "Add your mailing address",
      body: "The law requires a postal address in every commercial email. We add it to the footer.",
      href: "/app/settings/workspace",
      cta: "Add address",
      done: check(workspace, (w) => Boolean(w.mailingAddress)),
    },
    {
      title: "Connect a mailbox",
      body: "Send from your own Gmail or SMTP inbox, with a safe daily limit.",
      href: "/app/settings/mailboxes",
      cta: "Connect a mailbox",
      done: check(mailboxes, (m) => m.length > 0),
    },
    {
      title: "Import contacts",
      body: "Bring in a CSV. We flag duplicates and invalid rows before anything is saved.",
      href: "/app/contacts/import",
      cta: "Import a CSV",
      done: check(contacts, (c) => c.total > 0),
    },
    {
      title: "Create a sequence",
      body: "Write a few short emails once. Openline sends them during business hours.",
      href: "/app/sequences/new",
      cta: "Create a sequence",
      done: check(sequences, (list) => list.length > 0),
    },
    {
      title: "Enroll contacts",
      body: "Select contacts and choose “Add to sequence”. Unsafe sends are skipped for you.",
      href: "/app/contacts",
      cta: "Choose contacts",
      done: check(sequences, (list) => list.some((s) => enrolledCount(s) > 0)),
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  return (
    <>
      <PageHeader
        title={`Welcome, ${firstName}`}
        description={
          allDone
            ? `${me.workspace.name} is set up. Sequences are running.`
            : "Let's get your workspace ready to send safely."
        }
      />
      <TasksToday />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,42rem)_minmax(0,22rem)]">
        <div className="space-y-4 lg:order-2">
          <RepliesCard />
          <PromisesPanel limit={3} />
        </div>
        <Card className="max-w-2xl">
          <CardHeader
            title="Get started"
            description={`${doneCount} of ${steps.length} done for ${me.workspace.name}.`}
          />
          <div
            className="h-1 bg-slate-100 dark:bg-slate-800"
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={doneCount}
          >
            <div
              className="h-full bg-indigo-600 transition-[width] motion-reduce:transition-none"
              style={{ width: `${(doneCount / steps.length) * 100}%` }}
            />
          </div>
          <ol className="divide-y divide-slate-200 dark:divide-slate-800">
            {steps.map((step, i) => (
              <li key={step.title} className="flex gap-4 px-5 py-4">
                <span
                  className={cx(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium",
                    step.done
                      ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500"
                      : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-400",
                  )}
                >
                  {step.done === undefined ? (
                    <Spinner size="sm" label="" />
                  ) : step.done ? (
                    <svg
                      viewBox="0 0 20 20"
                      className="h-4 w-4"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  ) : (
                    <span aria-hidden="true">{i + 1}</span>
                  )}
                  <span className="sr-only">
                    {step.done === undefined ? "Checking" : step.done ? "Done" : "To do"}
                  </span>
                </span>
                <div className="flex-1">
                  <h3
                    className={cx(
                      "text-sm font-semibold",
                      step.done
                        ? "text-slate-600 line-through decoration-slate-400 dark:text-slate-400"
                        : "text-slate-900 dark:text-slate-100",
                    )}
                  >
                    {step.title}
                  </h3>
                  {!step.done ? (
                    <>
                      <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
                        {step.body}
                      </p>
                      {step.href === "/app" ? (
                        <p className="mt-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                          {step.cta}
                        </p>
                      ) : (
                        <Link
                          href={step.href}
                          className="mt-2 inline-block rounded text-sm font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-400"
                        >
                          {step.cta} →
                        </Link>
                      )}
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
