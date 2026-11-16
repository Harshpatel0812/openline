"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Avatar, Badge, Button, cx, Select, Spinner, useToast } from "@/components/ui";
import { api, ApiError, errorMessage, stopAuthRedirects } from "@/lib/api";
import { daysUntil } from "@/lib/format";
import { INBOX_CHANGED_EVENT } from "@/lib/inbox";
import { TASKS_CHANGED_EVENT } from "@/lib/tasks";
import type { InboxCountsDto, TaskCountsDto } from "@openline/shared";
import { Logo } from "./logo";
import { useMe } from "./me-context";

interface NavItem {
  label: string;
  href?: string;
  soon?: boolean;
  exact?: boolean;
  /** Count shown next to the label (e.g. replies needing action). */
  badge?: number;
  badgeLabel?: string;
  /** danger = red (overdue tasks); default indigo. */
  badgeTone?: "danger";
}

const mainNav: NavItem[] = [
  { label: "Today", href: "/app", exact: true },
  { label: "Inbox", href: "/app/inbox" },
  { label: "Tasks", href: "/app/tasks" },
  { label: "Contacts", href: "/app/contacts" },
  { label: "Companies", href: "/app/companies" },
  { label: "Sequences", href: "/app/sequences" },
  { label: "Pipeline", soon: true },
];

const settingsNav: NavItem[] = [
  { label: "Workspace", href: "/app/settings/workspace" },
  { label: "Mailboxes", href: "/app/settings/mailboxes" },
  { label: "Team", href: "/app/settings/team" },
  { label: "Suppressions", href: "/app/settings/suppressions" },
];

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        if (item.soon || !item.href) {
          return (
            <li key={item.label}>
              <span
                aria-disabled="true"
                className="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-2 text-sm text-slate-500 dark:text-slate-500"
              >
                {item.label}
                <Badge>Soon</Badge>
              </span>
            </li>
          );
        }
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <li key={item.label}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cx(
                "flex items-center rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600",
                active
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                  : "text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white",
              )}
            >
              {item.label}
              {item.badge ? (
                <span
                  className={cx(
                    "ml-auto rounded-full px-2 py-0.5 text-xs font-semibold text-white",
                    item.badgeTone === "danger"
                      ? "bg-red-700 dark:bg-red-600"
                      : "bg-indigo-600 dark:bg-indigo-500",
                  )}
                >
                  {item.badge > 99 ? "99+" : item.badge}
                  <span className="sr-only"> {item.badgeLabel}</span>
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Unhandled replies needing action, for the sidebar badge. Refreshes on navigation and events. */
function useNeedsActionCount(): number | undefined {
  const pathname = usePathname();
  const [count, setCount] = useState<number | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const bump = () => setNonce((n) => n + 1);
    window.addEventListener(INBOX_CHANGED_EVENT, bump);
    const timer = setInterval(bump, 120_000);
    return () => {
      window.removeEventListener(INBOX_CHANGED_EVENT, bump);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<InboxCountsDto>("/inbox/counts", { signal: controller.signal })
      .then((c) => setCount(c.needsAction))
      .catch(() => {
        // The badge is a hint; the inbox page shows real errors.
      });
    return () => controller.abort();
  }, [pathname, nonce]);

  return count;
}

/** My overdue tasks, for the sidebar badge. Refreshes on navigation and task changes. */
function useOverdueCount(): number | undefined {
  const pathname = usePathname();
  const [count, setCount] = useState<number | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const bump = () => setNonce((n) => n + 1);
    window.addEventListener(TASKS_CHANGED_EVENT, bump);
    const timer = setInterval(bump, 300_000);
    return () => {
      window.removeEventListener(TASKS_CHANGED_EVENT, bump);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<TaskCountsDto>("/tasks/counts", { signal: controller.signal })
      .then((c) => setCount(c.overdue))
      .catch(() => {
        // The badge is a hint; the tasks page shows real errors.
      });
    return () => controller.abort();
  }, [pathname, nonce]);

  return count;
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const needsAction = useNeedsActionCount();
  const overdue = useOverdueCount();
  const items = mainNav.map((item): NavItem =>
    item.href === "/app/inbox"
      ? { ...item, badge: needsAction, badgeLabel: "replies need action" }
      : item.href === "/app/tasks"
        ? { ...item, badge: overdue, badgeLabel: "overdue tasks", badgeTone: "danger" }
        : item,
  );
  return (
    <nav aria-label="Main" className="space-y-6">
      <NavLinks items={items} onNavigate={onNavigate} />
      <div>
        <h2 className="px-3 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Settings
        </h2>
        <NavLinks items={settingsNav} onNavigate={onNavigate} />
      </div>
    </nav>
  );
}

const VERIFY_DISMISS_KEY = "ol:verify-banner-dismissed";

/** Shown until the user verifies their email; can be hidden for the rest of the browser session. */
function VerifyEmailBanner() {
  const { me } = useMe();
  const { toast } = useToast();
  const [dismissed, setDismissed] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(VERIFY_DISMISS_KEY) === me.user.id);
    } catch {
      setDismissed(false);
    }
  }, [me.user.id]);

  if (me.user.emailVerified || dismissed) return null;

  async function resend() {
    setSending(true);
    try {
      await api("/auth/resend-verification", { method: "POST" });
      toast(`We've sent a new verification link to ${me.user.email}.`);
    } catch (err) {
      toast(
        err instanceof ApiError && err.status === 429
          ? "You've asked for several emails already. Please wait an hour and try again."
          : errorMessage(err),
        "error",
      );
    } finally {
      setSending(false);
    }
  }

  function dismiss() {
    try {
      sessionStorage.setItem(VERIFY_DISMISS_KEY, me.user.id);
    } catch {
      // Storage may be blocked; hiding for this page view is still fine.
    }
    setDismissed(true);
  }

  return (
    <div
      role="region"
      aria-label="Email verification"
      className="border-b border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="flex flex-col gap-2 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:px-6">
        <p className="flex-1">
          <span className="font-semibold">Verify your email</span> to connect a mailbox and start
          sequences. We sent a link to {me.user.email}.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" loading={sending} onClick={() => void resend()}>
            Resend email
          </Button>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md px-2 py-1 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
          >
            Hide for now
          </button>
        </div>
      </div>
    </div>
  );
}

function TrialBadge() {
  const { me } = useMe();
  if (me.workspace.plan !== "trial" || !me.workspace.trialEndsAt) return null;
  const days = daysUntil(me.workspace.trialEndsAt);
  return (
    <Badge tone={days <= 3 ? "warning" : "accent"}>
      {days === 0 ? "Trial ends today" : `Trial: ${days} day${days === 1 ? "" : "s"} left`}
    </Badge>
  );
}

function WorkspaceSwitcher() {
  const { me } = useMe();
  const { toast } = useToast();
  const [switching, setSwitching] = useState(false);
  const id = useId();

  if (me.workspaces.length <= 1) {
    return (
      <span className="max-w-[12rem] truncate text-sm font-medium text-slate-800 dark:text-slate-200">
        {me.workspace.name}
      </span>
    );
  }

  async function onChange(workspaceId: string) {
    if (workspaceId === me.workspace.id) return;
    setSwitching(true);
    try {
      await api("/auth/switch-workspace", { method: "POST", body: { workspaceId } });
      window.location.reload();
    } catch (err) {
      setSwitching(false);
      toast(errorMessage(err), "error");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        Switch workspace
      </label>
      <Select
        id={id}
        value={me.workspace.id}
        disabled={switching}
        onChange={(e) => void onChange(e.target.value)}
        className="h-9 max-w-[12rem]"
      >
        {me.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </Select>
      {switching ? <Spinner size="sm" label="Switching workspace" /> : null}
    </div>
  );
}

function UserMenu() {
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    stopAuthRedirects();
    try {
      await api("/auth/logout", { method: "POST", redirectOn401: false });
    } catch {
      // Even if the call fails, send the user to the login page.
    }
    window.location.assign("/login");
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950"
      >
        <Avatar name={me.user.name || me.user.email} size="sm" />
        <span className="sr-only">Account menu for {me.user.name}</span>
      </button>
      {open ? (
        <div
          id={menuId}
          className="absolute right-0 z-30 mt-2 w-64 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium">{me.user.name}</p>
            <p className="truncate text-xs text-slate-600 dark:text-slate-400">{me.user.email}</p>
          </div>
          <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {signingOut ? <Spinner size="sm" label="" /> : null}
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  const mobileNavId = useId();

  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white px-3 py-5 lg:block dark:border-slate-800 dark:bg-slate-900">
        <div className="px-3 pb-6">
          <Logo href="/app" />
        </div>
        <Navigation />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              className="-ml-1 rounded-md p-2 text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
              aria-expanded={menuOpen}
              aria-controls={mobileNavId}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                {menuOpen ? (
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                ) : (
                  <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
                )}
              </svg>
              <span className="sr-only">{menuOpen ? "Close menu" : "Open menu"}</span>
            </button>
            <div className="lg:hidden">
              <Logo href="/app" />
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden sm:inline-flex">
                <TrialBadge />
              </span>
              <WorkspaceSwitcher />
              <UserMenu />
            </div>
          </div>
          {menuOpen ? (
            <div
              id={mobileNavId}
              className="border-t border-slate-200 px-3 py-4 lg:hidden dark:border-slate-800"
            >
              <div className="mb-4 px-3 sm:hidden">
                <TrialBadge />
              </div>
              <Navigation onNavigate={() => setMenuOpen(false)} />
            </div>
          ) : null}
        </header>
        <VerifyEmailBanner />
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
