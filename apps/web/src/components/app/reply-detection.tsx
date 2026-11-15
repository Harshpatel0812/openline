"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { ImapSettingsInputSchema, type MailboxDto } from "@openline/shared";
import { Alert, Badge, Button, Checkbox, cx, Dialog, Field, Input } from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { zodFieldErrors } from "@/lib/format";
import { relativeTime, fullDateTime } from "@/lib/inbox";

/** Plain words for reply-detection errors (API codes and ?error= values from Google). */
const REPLY_DETECTION_ERRORS: Record<string, string> = {
  imap_auth_failed:
    "The mail server rejected the IMAP login. Check the username and password — many providers need an app password.",
  imap_unreachable:
    "We couldn't reach that IMAP server. Check the host name and port (993 for TLS, 143 for STARTTLS).",
  reply_detection_unavailable: "Reply detection isn't available for this kind of mailbox yet.",
  reply_access_denied:
    "Google didn't grant read access, so reply detection is still off. Try again and tick the box that lets Openline read your email.",
  wrong_google_account:
    "You signed in to Google with a different account. Use the account of the mailbox you're turning reply detection on for.",
  mailbox_not_found: "That mailbox is no longer connected.",
};

export function replyDetectionErrorMessage(code: string): string | undefined {
  return REPLY_DETECTION_ERRORS[code];
}

/**
 * IMAP host guess. MailboxDto doesn't include the SMTP host, so we work from the email domain,
 * with the big providers' real IMAP hosts.
 */
export function guessImapHost(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return "";
  if (domain === "gmail.com" || domain === "googlemail.com") return "imap.gmail.com";
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) {
    return "outlook.office365.com";
  }
  if (domain.startsWith("yahoo.")) return "imap.mail.yahoo.com";
  if (domain === "icloud.com" || domain === "me.com") return "imap.mail.me.com";
  return `imap.${domain}`;
}

// ------------------------------------------------------------------ status

export function ReplyDetectionStatus({ mailbox }: { mailbox: MailboxDto }) {
  const state = mailbox.replyDetection;
  return (
    <div className="text-xs text-slate-700 dark:text-slate-300">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span>Reply detection:</span>
        <Badge tone={state === "on" ? "success" : state === "error" ? "danger" : "neutral"}>
          {state === "on" ? "On" : state === "error" ? "Error" : "Off"}
        </Badge>
        {state !== "off" ? (
          <span className="text-slate-600 dark:text-slate-400">
            {mailbox.lastSyncedAt ? (
              <>
                Last checked{" "}
                <time dateTime={mailbox.lastSyncedAt} title={fullDateTime(mailbox.lastSyncedAt)}>
                  {relativeTime(mailbox.lastSyncedAt)}
                </time>
              </>
            ) : (
              "First check pending"
            )}
          </span>
        ) : null}
      </span>
      {state === "error" && mailbox.lastSyncError ? (
        <p className="mt-1 text-red-700 dark:text-red-400">
          {replyDetectionErrorMessage(mailbox.lastSyncError) ?? mailbox.lastSyncError}
        </p>
      ) : null}
      {state === "off" ? (
        <p className="mt-0.5 text-slate-600 dark:text-slate-400">
          Turn it on so sequences stop automatically when someone replies.
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ IMAP dialog

interface ImapValues {
  host: string;
  port: "993" | "143";
  separateLogin: boolean;
  username: string;
  password: string;
}

export function ImapDialog({
  mailbox,
  onClose,
  onSaved,
}: {
  mailbox: MailboxDto | null;
  onClose: () => void;
  onSaved: (m: MailboxDto) => void;
}) {
  const [values, setValues] = useState<ImapValues>({
    host: "",
    port: "993",
    separateLogin: false,
    username: "",
    password: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const securityName = useId();

  useEffect(() => {
    if (mailbox) {
      setValues({
        host: guessImapHost(mailbox.email),
        port: "993",
        separateLogin: false,
        username: mailbox.email,
        password: "",
      });
      setErrors({});
      setFormError(null);
    }
  }, [mailbox]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!mailbox) return;
    setFormError(null);
    const parsed = ImapSettingsInputSchema.safeParse({
      host: values.host,
      port: values.port,
      ...(values.separateLogin ? { username: values.username, password: values.password } : {}),
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const updated = await api<MailboxDto>(`/mailboxes/${mailbox.id}/imap`, {
        method: "PUT",
        body: parsed.data,
      });
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError && err.code === "imap_auth_failed") {
        setErrors(
          values.separateLogin
            ? { password: "The server rejected this username or password." }
            : {},
        );
        setFormError(
          values.separateLogin
            ? (REPLY_DETECTION_ERRORS.imap_auth_failed ?? errorMessage(err))
            : "The server rejected your SMTP login for IMAP. If your provider uses a different login or app password for IMAP, tick “Use a different login” and enter it.",
        );
      } else if (err instanceof ApiError && err.code === "imap_unreachable") {
        setErrors({ host: "Couldn't connect to this server and port." });
        setFormError(REPLY_DETECTION_ERRORS.imap_unreachable ?? errorMessage(err));
      } else if (err instanceof ApiError && err.code in REPLY_DETECTION_ERRORS) {
        setFormError(REPLY_DETECTION_ERRORS[err.code] ?? errorMessage(err));
      } else {
        const fe = fieldErrorsFrom(err);
        setErrors(fe);
        setFormError(
          Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  const on = mailbox?.replyDetection !== "off";

  return (
    <Dialog
      open={mailbox !== null}
      onClose={onClose}
      size="lg"
      title={on ? "Change IMAP settings" : "Turn on reply detection"}
      description={
        <>
          Openline checks <strong className="font-medium">{mailbox?.email}</strong>&apos;s inbox
          every couple of minutes for replies to your sequences, and stops the sequence when someone
          answers. Only replies to your outreach are kept; other email is never stored.
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {saving ? "Testing connection…" : on ? "Save IMAP settings" : "Turn on reply detection"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field
          label="IMAP host"
          hint="We guessed this from the email address — check your provider's settings."
          error={errors.host}
          required
        >
          {(p) => (
            <Input
              {...p}
              value={values.host}
              disabled={saving}
              placeholder="imap.example.com"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setValues((v) => ({ ...v, host: e.target.value }))}
            />
          )}
        </Field>

        <fieldset>
          <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">
            Security and port
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(
              [
                {
                  port: "993",
                  title: "SSL/TLS (port 993)",
                  body: "Recommended. Encrypted from the start.",
                },
                {
                  port: "143",
                  title: "STARTTLS (port 143)",
                  body: "Upgrades to encryption; required.",
                },
              ] as const
            ).map((opt) => (
              <label
                key={opt.port}
                className={cx(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm focus-within:ring-2 focus-within:ring-indigo-600",
                  values.port === opt.port
                    ? "border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950"
                    : "border-slate-300 dark:border-slate-700",
                )}
              >
                <input
                  type="radio"
                  name={securityName}
                  checked={values.port === opt.port}
                  onChange={() => setValues((v) => ({ ...v, port: opt.port }))}
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
          {errors.port ? (
            <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-400">{errors.port}</p>
          ) : null}
        </fieldset>

        <Checkbox
          label="Use a different login for IMAP"
          description="Leave this off to reuse the SMTP username and password you already saved."
          checked={values.separateLogin}
          disabled={saving}
          onChange={(e) => setValues((v) => ({ ...v, separateLogin: e.target.checked }))}
        />
        {values.separateLogin ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="IMAP username" error={errors.username} required>
              {(p) => (
                <Input
                  {...p}
                  value={values.username}
                  disabled={saving}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => setValues((v) => ({ ...v, username: e.target.value }))}
                />
              )}
            </Field>
            <Field label="IMAP password or app password" error={errors.password} required>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  value={values.password}
                  disabled={saving}
                  autoComplete="off"
                  onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
                />
              )}
            </Field>
          </div>
        ) : null}
        <p className="text-xs text-slate-600 dark:text-slate-400">
          We test the login before saving. Passwords are encrypted and never shown again.
        </p>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Gmail consent

export function GmailReplyDetectionDialog({
  mailbox,
  onClose,
}: {
  mailbox: MailboxDto | null;
  onClose: () => void;
}) {
  const [going, setGoing] = useState(false);
  useEffect(() => {
    if (mailbox) setGoing(false);
  }, [mailbox]);

  return (
    <Dialog
      open={mailbox !== null}
      onClose={onClose}
      title="Turn on reply detection for Gmail"
      description={mailbox?.email}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={going}>
            Cancel
          </Button>
          <Button
            loading={going}
            onClick={() => {
              if (!mailbox) return;
              setGoing(true);
              // Browser navigation: the API answers with a redirect to Google's consent screen.
              window.location.assign(
                `/api/v1/mailboxes/${encodeURIComponent(mailbox.id)}/google/reply-detection`,
              );
            }}
          >
            Continue to Google
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-800 dark:text-slate-200">
        <p>
          Google will ask you to let Openline <strong>read your email</strong>. We use it only to
          find replies to your sequences: matching replies are kept, everything else is ignored and
          never stored. Sending keeps working as before.
        </p>
        <Alert tone="warning" title="You'll see a warning screen first">
          Openline is still going through Google&apos;s verification, so Google shows “Google
          hasn&apos;t verified this app”. During the beta that&apos;s expected: choose{" "}
          <strong>Advanced</strong>, then <strong>Go to Openline</strong>, and tick the box that
          allows reading email.
        </Alert>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Sign in with {mailbox?.email ?? "this mailbox's Google account"} — another account
          won&apos;t work.
        </p>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ turn off

export function TurnOffReplyDetectionDialog({
  mailbox,
  onClose,
  onDone,
}: {
  mailbox: MailboxDto | null;
  onClose: () => void;
  onDone: (m: MailboxDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (mailbox) setError(null);
  }, [mailbox]);

  async function turnOff() {
    if (!mailbox) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<MailboxDto>(`/mailboxes/${mailbox.id}/imap`, { method: "DELETE" });
      onDone(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={mailbox !== null}
      onClose={onClose}
      size="sm"
      title="Turn off reply detection?"
      description={mailbox?.email}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void turnOff()}>
            Turn off
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : (
        <p className="text-sm">
          Replies to this mailbox won&apos;t be found any more, so sequences keep sending until you
          mark contacts as replied yourself.
          {mailbox?.provider === "smtp" ? " The saved IMAP settings and login are deleted." : ""}
        </p>
      )}
    </Dialog>
  );
}
