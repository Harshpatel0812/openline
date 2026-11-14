"use client";

import Link from "next/link";
import type {
  ContactListDto,
  MailboxDto,
  SequenceDto,
  WorkspaceSettingsDto,
} from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import { Card, CardHeader, cx, Spinner } from "@/components/ui";
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
                    <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{step.body}</p>
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
    </>
  );
}
