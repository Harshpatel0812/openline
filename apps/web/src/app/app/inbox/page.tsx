"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  REPLY_LABELS,
  type InboxCountsDto,
  type InboxItemDto,
  type InboxPageDto,
  type MailboxDto,
  type ReplyLabel,
} from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { InboxDetail } from "@/components/app/inbox-detail";
import { useMe } from "@/components/app/me-context";
import { ReplyLabelChip } from "@/components/app/reply-label";
import {
  Alert,
  Button,
  buttonClasses,
  Card,
  cx,
  EmptyState,
  LoadingBlock,
  Select,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import {
  fullDateTime,
  INBOX_CHANGED_EVENT,
  REPLY_LABEL_TEXT,
  relativeTime,
  senderName,
} from "@/lib/inbox";
import { useResource } from "@/lib/use-resource";

const PAGE_SIZE = 25;
type View = "needs" | "all";

function isLabel(v: string | null): v is ReplyLabel {
  return v !== null && (REPLY_LABELS as readonly string[]).includes(v);
}

// ------------------------------------------------------------------ list pieces

function RowSkeleton() {
  return (
    <li className="space-y-2 px-4 py-3" aria-hidden="true">
      <div className="flex justify-between gap-4">
        <div className="h-4 w-32 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
        <div className="h-4 w-12 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />
      </div>
      <div className="h-3 w-full animate-pulse rounded bg-slate-100 motion-reduce:animate-none dark:bg-slate-800/70" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-slate-100 motion-reduce:animate-none dark:bg-slate-800/70" />
    </li>
  );
}

function InboxRow({
  item,
  href,
  selected,
  linkRef,
}: {
  item: InboxItemDto;
  href: string;
  selected: boolean;
  linkRef: (el: HTMLAnchorElement | null) => void;
}) {
  const unhandled = !item.handledAt;
  const name = senderName(item);
  return (
    <li>
      <Link
        ref={linkRef}
        href={href}
        scroll={false}
        aria-current={selected ? "true" : undefined}
        className={cx(
          "block border-l-4 px-4 py-3 focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none focus-visible:ring-inset",
          selected
            ? "border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/60"
            : "border-transparent hover:bg-slate-50 dark:hover:bg-slate-800/60",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p
              className={cx(
                "truncate text-sm",
                unhandled
                  ? "font-semibold text-slate-900 dark:text-white"
                  : "font-medium text-slate-700 dark:text-slate-300",
              )}
            >
              {unhandled ? (
                <span
                  aria-hidden="true"
                  className="mr-1.5 inline-block h-2 w-2 rounded-full bg-indigo-600 align-middle dark:bg-indigo-400"
                />
              ) : null}
              {name}
              <span className="sr-only">{unhandled ? ", not handled yet" : ", handled"}</span>
            </p>
            {item.company ? (
              <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                {item.company.name}
              </p>
            ) : null}
          </div>
          <time
            dateTime={item.receivedAt}
            title={fullDateTime(item.receivedAt)}
            className="shrink-0 text-xs text-slate-600 dark:text-slate-400"
          >
            {relativeTime(item.receivedAt)}
          </time>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <ReplyLabelChip
            label={item.label}
            source={item.labelSource}
            confidence={item.labelConfidence}
          />
          {item.handledAt ? (
            <span className="text-xs text-slate-600 dark:text-slate-400">Handled</span>
          ) : null}
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm break-words text-slate-700 dark:text-slate-300">
          {item.summary || item.snippet || item.subject}
        </p>
        {item.sequence ? (
          <p className="mt-1 truncate text-xs text-slate-600 dark:text-slate-400">
            {item.sequence.name}
            {item.stepPosition ? ` · step ${item.stepPosition}` : ""}
          </p>
        ) : null}
      </Link>
    </li>
  );
}

// ------------------------------------------------------------------ page

function InboxView() {
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const viewId = useId();
  const labelId = useId();
  const mailboxSelectId = useId();

  const label = isLabel(params.get("label")) ? (params.get("label") as ReplyLabel) : null;
  const view: View = label || params.get("view") === "all" ? "all" : "needs";
  const mailboxId = params.get("mailbox") ?? "";
  const selectedId = params.get("message");

  const [items, setItems] = useState<InboxItemDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nonce, setNonce] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());
  const lastSelected = useRef<string | null>(null);

  const counts = useResource<InboxCountsDto>("/inbox/counts");
  const mailboxes = useResource<MailboxDto[]>("/mailboxes");
  const reloadCounts = counts.reload;

  useEffect(() => {
    const onChange = () => reloadCounts();
    window.addEventListener(INBOX_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(INBOX_CHANGED_EVENT, onChange);
  }, [reloadCounts]);

  const query = {
    label: label ?? undefined,
    mailboxId: mailboxId || undefined,
    needsAction: view === "needs" ? "true" : "false",
    limit: PAGE_SIZE,
  };
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<InboxPageDto>("/inbox", {
      query: JSON.parse(queryKey) as Record<string, string | number | undefined>,
      signal: controller.signal,
    })
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
  }, [queryKey, nonce]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api<InboxPageDto>("/inbox", {
        query: { ...(JSON.parse(queryKey) as Record<string, string | number>), cursor },
      });
      setItems((prev) => [...(prev ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  const hrefWith = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [params, pathname],
  );

  const setFilter = (patch: Record<string, string | null>) =>
    router.replace(hrefWith({ ...patch, message: null }), { scroll: false });

  // Remember which row was open so focus can go back to it.
  useEffect(() => {
    if (selectedId) lastSelected.current = selectedId;
  }, [selectedId]);

  function back() {
    router.replace(hrefWith({ message: null }), { scroll: false });
    const id = lastSelected.current;
    requestAnimationFrame(() => {
      if (id) rowRefs.current.get(id)?.focus();
    });
  }

  function onUpdated(m: InboxItemDto) {
    setItems((prev) => prev?.map((x) => (x.id === m.id ? { ...x, ...m } : x)) ?? prev);
  }

  const replyDetectionOn = mailboxes.data?.some((m) => m.replyDetection === "on") ?? true;
  const showMailboxFilter = (mailboxes.data?.length ?? 0) > 1;
  const needsCount = counts.data?.needsAction;

  const filterButton = (v: View, text: string) => (
    <button
      type="button"
      aria-pressed={view === v}
      onClick={() => setFilter({ view: v === "all" ? "all" : null, label: null })}
      className={cx(
        "h-9 rounded-md px-3 text-sm font-medium focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none",
        view === v
          ? "bg-white text-slate-900 shadow-xs dark:bg-slate-700 dark:text-white"
          : "text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white",
      )}
    >
      {text}
    </button>
  );

  const list = (
    <Card className="overflow-hidden">
      <div className="space-y-3 border-b border-slate-200 p-3 dark:border-slate-800">
        <div
          role="group"
          aria-labelledby={viewId}
          className="inline-flex rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
        >
          <span id={viewId} className="sr-only">
            Show
          </span>
          {filterButton(
            "needs",
            needsCount !== undefined ? `Needs action (${needsCount})` : "Needs action",
          )}
          {filterButton("all", "All replies")}
        </div>
        <div className={cx("grid gap-2", showMailboxFilter && "sm:grid-cols-2 lg:grid-cols-1")}>
          <div>
            <label htmlFor={labelId} className="sr-only">
              Filter by label
            </label>
            <Select
              id={labelId}
              value={label ?? ""}
              onChange={(e) => setFilter({ label: e.target.value || null, view: null })}
              className="h-9"
            >
              <option value="">Any label</option>
              {REPLY_LABELS.map((l) => (
                <option key={l} value={l}>
                  {REPLY_LABEL_TEXT[l]}
                  {counts.data ? ` (${counts.data.byLabel[l] ?? 0} open)` : ""}
                </option>
              ))}
            </Select>
          </div>
          {showMailboxFilter ? (
            <div>
              <label htmlFor={mailboxSelectId} className="sr-only">
                Filter by mailbox
              </label>
              <Select
                id={mailboxSelectId}
                value={mailboxId}
                onChange={(e) => setFilter({ mailbox: e.target.value || null })}
                className="h-9"
              >
                <option value="">All mailboxes</option>
                {mailboxes.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.email}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
      </div>

      <div aria-live="polite" aria-busy={loading}>
        {loading && !items ? (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
            <li className="sr-only">Loading replies…</li>
          </ul>
        ) : error && !items ? (
          <div className="p-4">
            <Alert tone="error" title="Couldn't load replies">
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
          view === "needs" && !label && !mailboxId ? (
            <EmptyState
              title="You're all caught up"
              description={
                replyDetectionOn
                  ? "Replies that need a person — interested, referrals, “not now” and anything unclear — show up here."
                  : "Turn on reply detection for a mailbox so replies show up here and sequences stop when someone answers."
              }
              action={
                replyDetectionOn ? (
                  <Button variant="secondary" onClick={() => setFilter({ view: "all" })}>
                    See all replies
                  </Button>
                ) : (
                  <Link href="/app/settings/mailboxes" className={buttonClasses("secondary")}>
                    Set up reply detection
                  </Link>
                )
              }
            />
          ) : (
            <EmptyState
              title="No replies here"
              description={
                label || mailboxId
                  ? "Nothing matches these filters. Try another label or mailbox."
                  : "When contacts answer your sequences, their replies appear here."
              }
            />
          )
        ) : (
          <>
            <p className="sr-only">
              {items.length} {items.length === 1 ? "reply" : "replies"} shown
            </p>
            <ul
              aria-label="Replies"
              className={cx(
                "divide-y divide-slate-200 dark:divide-slate-800",
                loading && "opacity-60",
              )}
            >
              {items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  href={hrefWith({ message: item.id })}
                  selected={item.id === selectedId}
                  linkRef={(el) => {
                    if (el) rowRefs.current.set(item.id, el);
                    else rowRefs.current.delete(item.id);
                  }}
                />
              ))}
            </ul>
            {cursor ? (
              <div className="border-t border-slate-200 p-3 text-center dark:border-slate-800">
                <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Inbox"
        description={
          can("owner", "admin", "manager")
            ? "Replies to your team's sequences, from every mailbox. Sequences stop as soon as someone replies."
            : "Replies to emails sent from your mailboxes. Sequences stop as soon as someone replies."
        }
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <div className={cx(selectedId && "hidden lg:block")}>{list}</div>
        <div className={cx(!selectedId && "hidden lg:block")}>
          {selectedId ? (
            <InboxDetail key={selectedId} id={selectedId} onUpdated={onUpdated} onBack={back} />
          ) : (
            <Card>
              <EmptyState
                title="Pick a reply to read it"
                description="You can label it, reply, ask Scout for a draft, or mark it handled."
              />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading inbox" />}>
      <InboxView />
    </Suspense>
  );
}
