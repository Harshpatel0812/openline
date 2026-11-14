"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ENROLLMENT_STATES, type EnrollmentDto, type SequenceDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { EnrollmentActions, EnrollmentStateBadge } from "@/components/app/enrollments";
import { useMe } from "@/components/app/me-context";
import { SequenceEditor } from "@/components/app/sequence-editor";
import { SequencePreview } from "@/components/app/sequence-preview";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  Dialog,
  EmptyState,
  LoadingBlock,
  Select,
  Table,
  Td,
  Th,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import {
  enrollmentStatus,
  enrollmentContactName,
  formatDateTime,
  SEQUENCE_STATUS_TONES,
  titleCase,
} from "@/lib/labels";
import { useResource } from "@/lib/use-resource";

const TABS = ["steps", "preview", "enrollments"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  steps: "Steps",
  preview: "Preview",
  enrollments: "Enrollments",
};

// ------------------------------------------------------------------ status controls

type Status = "active" | "paused" | "archived";

function statusError(err: unknown): ReactNode {
  if (err instanceof ApiError && err.code === "mailing_address_required") {
    return (
      <>
        Every email must include your postal address (CAN-SPAM). Add it in{" "}
        <Link href="/app/settings/workspace" className="font-medium underline">
          workspace settings
        </Link>
        , then activate again.
      </>
    );
  }
  if (err instanceof ApiError && err.code === "email_not_verified") {
    return "Verify your email address first — use “Resend email” in the banner at the top of the page.";
  }
  if (err instanceof ApiError && err.status === 403) {
    return "Only owners, admins and managers can activate, pause or archive sequences.";
  }
  return errorMessage(err);
}

function StatusControls({
  sequence,
  onChanged,
}: {
  sequence: SequenceDto;
  onChanged: (s: SequenceDto) => void;
}) {
  const { can } = useMe();
  const { toast } = useToast();
  const [busy, setBusy] = useState<Status | null>(null);
  const [error, setError] = useState<ReactNode>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const allowed = can("owner", "admin", "manager");

  async function setStatus(status: Status) {
    setBusy(status);
    setError(null);
    try {
      const updated = await api<SequenceDto>(`/sequences/${sequence.id}/status`, {
        method: "POST",
        body: { status },
      });
      onChanged(updated);
      setConfirmArchive(false);
      toast(
        status === "active"
          ? "Sequence is active"
          : status === "paused"
            ? "Sequence paused — no emails go out until you resume it"
            : "Sequence archived",
      );
    } catch (err) {
      setConfirmArchive(false);
      setError(statusError(err));
    } finally {
      setBusy(null);
    }
  }

  if (sequence.status === "archived") return null;

  const buttons = allowed ? (
    <div className="flex flex-wrap gap-2">
      {sequence.status !== "active" ? (
        <Button
          loading={busy === "active"}
          disabled={busy !== null || sequence.steps.length === 0}
          onClick={() => void setStatus("active")}
        >
          {sequence.status === "paused" ? "Resume" : "Activate"}
        </Button>
      ) : (
        <Button
          variant="secondary"
          loading={busy === "paused"}
          disabled={busy !== null}
          onClick={() => void setStatus("paused")}
        >
          Pause
        </Button>
      )}
      <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmArchive(true)}>
        Archive
      </Button>
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      {buttons}
      {!allowed ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Ask a manager or admin to activate or pause this sequence.
        </p>
      ) : null}
      {error ? (
        <Alert tone="error" title="Status not changed">
          {error}
        </Alert>
      ) : null}
      <Dialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        size="sm"
        title="Archive this sequence?"
        description="It's hidden from the list and stops sending. Enrolled contacts get no more emails from it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmArchive(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy === "archived"}
              onClick={() => void setStatus("archived")}
            >
              Archive
            </Button>
          </>
        }
      />
    </div>
  );
}

// ------------------------------------------------------------------ enrollments

const PAGE_SIZE = 50;

function EnrollmentsPanel({ sequence }: { sequence: SequenceDto }) {
  const { toast } = useToast();
  const [state, setState] = useState("");
  const [items, setItems] = useState<EnrollmentDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nonce, setNonce] = useState(0);
  const filterId = useId();
  const stepCount = sequence.steps.length;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<{ items: EnrollmentDto[]; nextCursor: string | null }>(
      `/sequences/${sequence.id}/enrollments`,
      { query: { state: state || undefined, limit: PAGE_SIZE }, signal: controller.signal },
    )
      .then((r) => {
        setItems(r.items);
        setCursor(r.nextCursor);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [sequence.id, state, nonce]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api<{ items: EnrollmentDto[]; nextCursor: string | null }>(
        `/sequences/${sequence.id}/enrollments`,
        { query: { state: state || undefined, limit: PAGE_SIZE, cursor } },
      );
      setItems((prev) => [...(prev ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, sequence.id, state, toast]);

  const nextStepLabel = (e: EnrollmentDto) =>
    e.state === "active" || e.state === "paused"
      ? e.nextPosition > stepCount
        ? "—"
        : `Step ${e.nextPosition} of ${stepCount}`
      : "—";

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
        <div className="flex items-center gap-2">
          <label
            htmlFor={filterId}
            className="text-sm font-medium text-slate-800 dark:text-slate-200"
          >
            State
          </label>
          <Select
            id={filterId}
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="h-9 w-44"
          >
            <option value="">All states</option>
            {ENROLLMENT_STATES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Times are shown in your local time zone.
        </p>
      </div>

      {loading && !items ? (
        <LoadingBlock label="Loading enrollments" />
      ) : error ? (
        <div className="p-4">
          <Alert tone="error" title="Couldn't load enrollments">
            {errorMessage(error)}{" "}
            <button
              type="button"
              className="font-medium underline"
              onClick={() => setNonce((n) => n + 1)}
            >
              Try again
            </button>
          </Alert>
        </div>
      ) : !items || items.length === 0 ? (
        <EmptyState
          title={state ? `No ${titleCase(state).toLowerCase()} enrollments` : "No one enrolled yet"}
          description={
            state
              ? "Try another state."
              : sequence.status === "active"
                ? "Pick contacts on the Contacts page and choose “Add to sequence”."
                : "Activate the sequence, then add contacts from the Contacts page."
          }
          action={
            !state ? (
              <Link
                href="/app/contacts"
                className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-400"
              >
                Go to contacts →
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <div aria-busy={loading} className={loading ? "opacity-60" : undefined}>
            <Table caption="Enrollments" className="[&_table]:min-w-[960px]">
              <thead>
                <tr>
                  <Th>Contact</Th>
                  <Th>Mailbox</Th>
                  <Th>State</Th>
                  <Th>Next step</Th>
                  <Th>Next send</Th>
                  <Th>Latest status</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => {
                  const name = enrollmentContactName(e.contact);
                  const status = enrollmentStatus(e);
                  return (
                    <tr key={e.id}>
                      <Td>
                        <Link
                          href={`/app/contacts/${e.contact.id}`}
                          className="rounded font-medium text-slate-900 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-white"
                        >
                          {name}
                        </Link>
                        {name !== e.contact.email ? (
                          <p className="text-xs text-slate-600 dark:text-slate-400">
                            {e.contact.email}
                          </p>
                        ) : null}
                      </Td>
                      <Td className="text-slate-600 dark:text-slate-400">{e.mailbox.email}</Td>
                      <Td>
                        <EnrollmentStateBadge state={e.state} />
                      </Td>
                      <Td className="whitespace-nowrap">{nextStepLabel(e)}</Td>
                      <Td className="whitespace-nowrap">
                        {e.state === "active" ? formatDateTime(e.nextRunAt) : "—"}
                      </Td>
                      <Td className="max-w-[16rem]">
                        <span>{status.label}</span>
                        {status.error ? (
                          <p className="text-xs text-red-700 dark:text-red-400">{status.error}</p>
                        ) : null}
                      </Td>
                      <Td>
                        <EnrollmentActions
                          enrollment={e}
                          label={name}
                          onUpdated={(u) =>
                            setItems((prev) => prev?.map((x) => (x.id === u.id ? u : x)) ?? null)
                          }
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
          <div className="flex flex-col items-center gap-2 p-4 text-sm text-slate-600 sm:flex-row sm:justify-between dark:text-slate-400">
            <p aria-live="polite">Showing {items.length.toLocaleString()}</p>
            {cursor ? (
              <Button
                variant="secondary"
                size="sm"
                loading={loadingMore}
                onClick={() => void loadMore()}
              >
                Load more
              </Button>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ tabs

function Tabs({
  tab,
  onChange,
  counts,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: Partial<Record<Tab, number>>;
}) {
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({
    steps: null,
    preview: null,
    enrollments: null,
  });
  return (
    <div
      role="tablist"
      aria-label="Sequence sections"
      className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const i = TABS.indexOf(tab);
        const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
        if (next) {
          onChange(next);
          refs.current[next]?.focus();
        }
      }}
    >
      {TABS.map((t) => (
        <button
          key={t}
          ref={(el) => {
            refs.current[t] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${t}`}
          aria-selected={tab === t}
          aria-controls={`panel-${t}`}
          tabIndex={tab === t ? 0 : -1}
          onClick={() => onChange(t)}
          className={cx(
            "-mb-px border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none",
            tab === t
              ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
              : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white",
          )}
        >
          {TAB_LABELS[t]}
          {counts[t] !== undefined ? (
            <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">{counts[t]}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function SequenceDetail() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const requested = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as Tab)
    : "steps";
  const { data, error, loading, reload, setData } = useResource<SequenceDto>(`/sequences/${id}`);

  const setTab = (t: Tab) =>
    router.replace(t === "steps" ? pathname : `${pathname}?tab=${t}`, { scroll: false });

  if (loading && !data) return <LoadingBlock label="Loading sequence" />;
  if (error || !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="max-w-xl space-y-4">
        <Alert tone="error" title={notFound ? "Sequence not found" : "Couldn't load this sequence"}>
          {notFound
            ? "It may have been deleted, or it belongs to a different workspace."
            : errorMessage(error)}
        </Alert>
        <div className="flex gap-2">
          <Link
            href="/app/sequences"
            className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-400"
          >
            ← Back to sequences
          </Link>
          {!notFound ? (
            <Button variant="ghost" size="sm" onClick={reload}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const s = data.stats;
  const enrolledTotal =
    s.active + s.completed + s.replied + s.unsubscribed + s.bounced + s.stopped + s.error;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/app/sequences" className="text-slate-600 hover:underline dark:text-slate-400">
          Sequences
        </Link>
        <span aria-hidden="true" className="mx-2 text-slate-400">
          /
        </span>
        <span aria-current="page" className="text-slate-900 dark:text-slate-100">
          {data.name}
        </span>
      </nav>
      <PageHeader
        title={data.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={SEQUENCE_STATUS_TONES[data.status]}>{titleCase(data.status)}</Badge>
            <span>
              {data.steps.length} step{data.steps.length === 1 ? "" : "s"}
            </span>
            <span>{s.active} active</span>
            <span>{s.sent} sent</span>
            <span>{s.replied} replied</span>
            <span>{s.unsubscribed} unsubscribed</span>
          </span>
        }
        actions={<StatusControls sequence={data} onChanged={(u) => setData(() => u)} />}
      />

      <Tabs tab={tab} onChange={setTab} counts={{ enrollments: enrolledTotal }} />

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "steps" ? (
          <div className="max-w-3xl">
            <SequenceEditor sequence={data} onSaved={(u) => setData(() => u)} />
          </div>
        ) : tab === "preview" ? (
          <div className="max-w-3xl">
            <SequencePreview sequenceId={data.id} version={data.updatedAt} />
          </div>
        ) : (
          <EnrollmentsPanel sequence={data} />
        )}
      </div>
    </>
  );
}

export default function SequenceDetailPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading sequence" />}>
      <SequenceDetail />
    </Suspense>
  );
}
