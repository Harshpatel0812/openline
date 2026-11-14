"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useState, type FormEvent } from "react";
import {
  MailboxUpdateInputSchema,
  SmtpMailboxInputSchema,
  type MailboxDto,
  type MemberDto,
} from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  cx,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Select,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { titleCase, zodFieldErrors } from "@/lib/format";
import { MAILBOX_STATUS_TONES, mailboxErrorMessage, PROVIDER_LABELS } from "@/lib/labels";
import { useResource } from "@/lib/use-resource";

// ------------------------------------------------------------------ usage bar

function UsageBar({ sent, cap }: { sent: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((sent / cap) * 100)) : 0;
  const tone = pct >= 100 ? "bg-red-600" : pct >= 80 ? "bg-amber-500" : "bg-indigo-600";
  return (
    <div className="min-w-[8rem]">
      <p className="text-sm text-slate-800 dark:text-slate-200">
        <span className="font-medium">{sent}</span>
        <span className="text-slate-600 dark:text-slate-400"> / {cap} sent today</span>
      </p>
      <div
        role="progressbar"
        aria-label="Sent today"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(sent, cap)}
        aria-valuetext={`${sent} of ${cap} emails sent today`}
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
      >
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ edit cap

function EditCapDialog({
  mailbox,
  onClose,
  onSaved,
}: {
  mailbox: MailboxDto | null;
  onClose: () => void;
  onSaved: (m: MailboxDto) => void;
}) {
  const [cap, setCap] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();

  useEffect(() => {
    if (mailbox) {
      setCap(String(mailbox.dailyCap));
      setError(null);
    }
  }, [mailbox]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!mailbox) return;
    const parsed = MailboxUpdateInputSchema.safeParse({ dailyCap: cap });
    if (!parsed.success) {
      setError("Enter a whole number from 1 to 200");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api<MailboxDto>(`/mailboxes/${mailbox.id}`, {
        method: "PATCH",
        body: parsed.data,
      });
      onSaved(updated);
    } catch (err) {
      setError(fieldErrorsFrom(err).dailyCap ?? errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={mailbox !== null}
      onClose={onClose}
      size="sm"
      title="Daily sending limit"
      description={mailbox?.email}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Save limit
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate>
        <Field
          label="Emails per day"
          hint="Start low (20–50/day) to protect your domain's reputation. Maximum 200."
          error={error ?? undefined}
        >
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="numeric"
              min={1}
              max={200}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ remove

function RemoveDialog({
  mailbox,
  onClose,
  onRemoved,
}: {
  mailbox: MailboxDto | null;
  onClose: () => void;
  onRemoved: (m: MailboxDto) => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mailbox) setError(null);
  }, [mailbox]);

  async function remove() {
    if (!mailbox) return;
    setRemoving(true);
    setError(null);
    try {
      await api(`/mailboxes/${mailbox.id}`, { method: "DELETE" });
      onRemoved(mailbox);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Dialog
      open={mailbox !== null}
      onClose={onClose}
      size="sm"
      title="Remove this mailbox?"
      description={
        <>
          <strong className="font-medium">{mailbox?.email}</strong> will be disconnected. Active
          sequences using it will stop for the contacts it was sending to.
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={removing}>
            Cancel
          </Button>
          <Button variant="danger" loading={removing} onClick={() => void remove()}>
            Remove mailbox
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : (
        <p className="text-sm">This can&apos;t be undone.</p>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ connect SMTP

interface SmtpValues {
  email: string;
  displayName: string;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  dailyCap: string;
}

const emptySmtp: SmtpValues = {
  email: "",
  displayName: "",
  host: "",
  port: "587",
  secure: false,
  username: "",
  password: "",
  dailyCap: "50",
};

function ConnectSmtpDialog({
  open,
  onClose,
  onConnected,
  defaultName,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (m: MailboxDto) => void;
  defaultName: string;
}) {
  const [values, setValues] = useState<SmtpValues>(emptySmtp);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const securityName = useId();

  useEffect(() => {
    if (open) {
      setValues({ ...emptySmtp, displayName: defaultName });
      setErrors({});
      setFormError(null);
    }
  }, [open, defaultName]);

  const set = <K extends keyof SmtpValues>(key: K, value: SmtpValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = SmtpMailboxInputSchema.safeParse({
      ...values,
      displayName: values.displayName.trim() || undefined,
      username: values.username.trim() || values.email.trim(),
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const created = await api<MailboxDto>("/mailboxes/smtp", {
        method: "POST",
        body: parsed.data,
      });
      onConnected(created);
    } catch (err) {
      if (err instanceof ApiError && err.code === "mailbox_auth_failed") {
        setErrors({ password: "The server rejected this username or password." });
        setFormError(mailboxErrorMessage(err));
      } else if (err instanceof ApiError && err.code === "mailbox_unreachable") {
        setErrors({ host: "Couldn't connect to this server and port." });
        setFormError(mailboxErrorMessage(err));
      } else if (err instanceof ApiError && err.code === "email_not_verified") {
        setFormError(
          "Verify your email address first — use “Resend email” in the banner at the top of the page.",
        );
      } else {
        const fe = fieldErrorsFrom(err);
        setErrors(fe);
        setFormError(
          Object.keys(fe).length ? "Please fix the highlighted fields." : mailboxErrorMessage(err),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const text = (key: Exclude<keyof SmtpValues, "secure">) => ({
    value: values[key],
    disabled: saving,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      set(key, e.target.value),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Connect an SMTP mailbox"
      description="We test the login before saving. Your password is encrypted and never shown again."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {saving ? "Testing connection…" : "Connect mailbox"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Alert tone="info" title="Using Google Workspace or Microsoft 365?">
          Turn on 2-step verification and create an <strong>app password</strong> for Openline —
          your normal password won&apos;t work. Google: smtp.gmail.com, port 465 (SSL/TLS) or 587.
          Microsoft 365: smtp.office365.com, port 587 (STARTTLS), with SMTP AUTH enabled by your
          admin.
        </Alert>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email address" error={errors.email} required>
            {(p) => <Input {...p} {...text("email")} type="email" autoComplete="off" required />}
          </Field>
          <Field label="Display name" hint="Shown as the sender" error={errors.displayName}>
            {(p) => <Input {...p} {...text("displayName")} autoComplete="off" />}
          </Field>
          <Field label="SMTP host" error={errors.host} required>
            {(p) => (
              <Input
                {...p}
                {...text("host")}
                placeholder="smtp.example.com"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="Port" error={errors.port} required>
            {(p) => (
              <Select
                {...p}
                value={values.port}
                disabled={saving}
                onChange={(e) => {
                  const port = e.target.value;
                  setValues((v) => ({ ...v, port, secure: port === "465" }));
                }}
              >
                <option value="587">587 (recommended)</option>
                <option value="465">465</option>
                <option value="25">25</option>
                <option value="2525">2525</option>
              </Select>
            )}
          </Field>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Security
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {[
              {
                secure: true,
                title: "SSL/TLS",
                body: "Encrypted from the start. Usually port 465.",
              },
              {
                secure: false,
                title: "STARTTLS",
                body: "Upgrades to encryption. Usually 587, 25 or 2525.",
              },
            ].map((opt) => (
              <label
                key={opt.title}
                className={cx(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm focus-within:ring-2 focus-within:ring-indigo-600",
                  values.secure === opt.secure
                    ? "border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950"
                    : "border-slate-300 dark:border-slate-700",
                )}
              >
                <input
                  type="radio"
                  name={securityName}
                  checked={values.secure === opt.secure}
                  onChange={() => set("secure", opt.secure)}
                  disabled={saving}
                  className="mt-0.5 accent-indigo-600"
                />
                <span>
                  <span className="block font-medium">{opt.title}</span>
                  <span className="text-slate-600 dark:text-slate-400">{opt.body}</span>
                </span>
              </label>
            ))}
          </div>
          {errors.secure ? (
            <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-400">
              {errors.secure}
            </p>
          ) : null}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" hint="Usually your full email address" error={errors.username}>
            {(p) => (
              <Input
                {...p}
                {...text("username")}
                placeholder={values.email || undefined}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="Password or app password" error={errors.password} required>
            {(p) => <Input {...p} {...text("password")} type="password" autoComplete="off" />}
          </Field>
          <Field
            label="Daily sending limit"
            hint="Start low (20–50/day) to protect your domain's reputation."
            error={errors.dailyCap}
          >
            {(p) => (
              <Input
                {...p}
                {...text("dailyCap")}
                type="number"
                inputMode="numeric"
                min={1}
                max={200}
              />
            )}
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ page

function MailboxesView() {
  const { me, can } = useMe();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const isAdmin = can("owner", "admin");
  const { data, error, loading, reload, setData } = useResource<MailboxDto[]>("/mailboxes");
  const members = useResource<MemberDto[]>("/members");
  const [connecting, setConnecting] = useState(false);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailUnavailable, setGmailUnavailable] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MailboxDto | null>(null);
  const [removing, setRemoving] = useState<MailboxDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // ?connected=gmail and ?error=<code> come back from the Google OAuth callback.
  useEffect(() => {
    const connected = params.get("connected");
    const err = params.get("error");
    if (!connected && !err) return;
    if (connected === "gmail") toast("Gmail mailbox connected");
    if (err) setCallbackError(mailboxErrorMessage(err));
    router.replace(pathname, { scroll: false });
  }, [params, pathname, router, toast]);

  const ownerName = (id: string) =>
    id === me.user.id ? "You" : (members.data?.find((m) => m.userId === id)?.name ?? "Teammate");
  const canManage = (m: MailboxDto) => isAdmin || m.ownerId === me.user.id;

  async function connectGmail() {
    setGmailLoading(true);
    setGmailError(null);
    try {
      const { url } = await api<{ url: string }>("/mailboxes/google/authorize");
      window.location.assign(url);
    } catch (err) {
      setGmailLoading(false);
      if (err instanceof ApiError && (err.code === "google_not_configured" || err.status === 501)) {
        setGmailUnavailable(true);
      } else if (err instanceof ApiError && err.code === "email_not_verified") {
        setGmailError(
          "Verify your email address first — use “Resend email” in the banner at the top of the page.",
        );
      } else {
        setGmailError(mailboxErrorMessage(err));
      }
    }
  }

  async function toggleStatus(m: MailboxDto) {
    setBusyId(m.id);
    try {
      const updated = await api<MailboxDto>(`/mailboxes/${m.id}`, {
        method: "PATCH",
        body: { status: m.status === "paused" ? "active" : "paused" },
      });
      setData((prev) => prev?.map((x) => (x.id === updated.id ? updated : x)));
      toast(updated.status === "paused" ? `Paused ${m.email}` : `Resumed ${m.email}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  }

  const connectButtons = (
    <>
      <Button
        variant="secondary"
        onClick={() => void connectGmail()}
        loading={gmailLoading}
        disabled={gmailUnavailable}
        aria-describedby={gmailUnavailable ? "gmail-unavailable" : undefined}
      >
        Connect Gmail
      </Button>
      <Button onClick={() => setConnecting(true)}>Connect SMTP</Button>
    </>
  );

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="The inboxes your sequences send from. Each one has its own daily limit."
        actions={connectButtons}
      />

      <div className="space-y-4">
        {callbackError ? (
          <Alert tone="error" title="The mailbox wasn't connected">
            {callbackError}
          </Alert>
        ) : null}
        {gmailUnavailable ? (
          <div id="gmail-unavailable">
            <Alert tone="info">
              Gmail connection isn&apos;t set up on this server yet. You can still connect Gmail or
              Google Workspace through SMTP with an app password.
            </Alert>
          </div>
        ) : null}
        {gmailError ? <Alert tone="error">{gmailError}</Alert> : null}

        <Card>
          <CardHeader
            title="Connected mailboxes"
            description={
              isAdmin
                ? "All mailboxes in this workspace."
                : "Mailboxes in this workspace. You can manage your own."
            }
          />
          {loading && !data ? (
            <LoadingBlock label="Loading mailboxes" />
          ) : error ? (
            <div className="p-4">
              <Alert tone="error" title="Couldn't load mailboxes">
                {errorMessage(error)}{" "}
                <button type="button" className="font-medium underline" onClick={reload}>
                  Try again
                </button>
              </Alert>
            </div>
          ) : !data || data.length === 0 ? (
            <EmptyState
              title="No mailboxes yet"
              description="Connect the inbox you want sequences to send from. Replies land there too."
              action={<div className="flex flex-wrap justify-center gap-2">{connectButtons}</div>}
            />
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.map((m) => (
                <li
                  key={m.id}
                  className="flex flex-col gap-4 px-5 py-4 md:flex-row md:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                        {m.email}
                      </p>
                      <Badge tone="accent">{PROVIDER_LABELS[m.provider]}</Badge>
                      <Badge tone={MAILBOX_STATUS_TONES[m.status]}>{titleCase(m.status)}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                      {m.displayName ? `${m.displayName} · ` : ""}Owner: {ownerName(m.ownerId)}
                    </p>
                    {m.lastError ? (
                      <p className="mt-1 text-xs text-red-700 dark:text-red-400">
                        Last error: {m.lastError}
                      </p>
                    ) : null}
                  </div>
                  <UsageBar sent={m.sentToday} cap={m.dailyCap} />
                  {canManage(m) ? (
                    <div className="flex flex-wrap gap-2">
                      {m.status === "active" || m.status === "paused" ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busyId === m.id}
                          onClick={() => void toggleStatus(m)}
                          aria-label={`${m.status === "paused" ? "Resume" : "Pause"} ${m.email}`}
                        >
                          {m.status === "paused" ? "Resume" : "Pause"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditing(m)}
                        aria-label={`Edit daily limit for ${m.email}`}
                      >
                        Edit limit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-700 dark:text-red-400"
                        onClick={() => setRemoving(m)}
                        aria-label={`Remove ${m.email}`}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <ConnectSmtpDialog
        open={connecting}
        defaultName={me.user.name}
        onClose={() => setConnecting(false)}
        onConnected={(m) => {
          setConnecting(false);
          setData((prev) => [...(prev ?? []).filter((x) => x.id !== m.id), m]);
          toast(`Connected ${m.email}`);
        }}
      />
      <EditCapDialog
        mailbox={editing}
        onClose={() => setEditing(null)}
        onSaved={(m) => {
          setEditing(null);
          setData((prev) => prev?.map((x) => (x.id === m.id ? m : x)));
          toast(`Daily limit set to ${m.dailyCap}`);
        }}
      />
      <RemoveDialog
        mailbox={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(m) => {
          setRemoving(null);
          setData((prev) => prev?.filter((x) => x.id !== m.id));
          toast(`Removed ${m.email}`);
        }}
      />
    </>
  );
}

export default function MailboxesPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading mailboxes" />}>
      <MailboxesView />
    </Suspense>
  );
}
