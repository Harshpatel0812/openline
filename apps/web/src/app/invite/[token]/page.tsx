"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { InviteLookupDto, MeResponse } from "@openline/shared";
import { PasswordSchema } from "@openline/shared";
import { AuthShell } from "@/components/app/logo";
import {
  Alert,
  Button,
  buttonClasses,
  Field,
  Input,
  LoadingBlock,
  RoleBadge,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom, loginUrl } from "@/lib/api";

const statusMessages: Record<Exclude<InviteLookupDto["status"], "valid">, string> = {
  expired: "This invite has expired. Ask the person who invited you to send a new one.",
  used: "This invite has already been accepted. Sign in to get to your workspace.",
  revoked: "This invite was revoked. Ask a workspace admin if you still need access.",
};

const goneCodes: Record<string, string> = {
  invite_used: statusMessages.used,
  invite_expired: statusMessages.expired,
  invite_revoked: statusMessages.revoked,
};

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const router = useRouter();
  const [invite, setInvite] = useState<InviteLookupDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<React.ReactNode>(null);
  const [submitting, setSubmitting] = useState(false);
  const invitePath = `/invite/${token}`;

  useEffect(() => {
    let cancelled = false;
    api<InviteLookupDto>("/invites/lookup", { query: { token }, redirectOn401: false })
      .then((data) => {
        if (cancelled) return;
        setInvite(data);
        if (data.accountExists) {
          api<MeResponse>("/auth/me", { redirectOn401: false })
            .then((m) => !cancelled && setMe(m))
            .catch(() => undefined);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? "We couldn't find this invite. Check that you copied the whole link."
            : errorMessage(err),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept(body: { token: string; name?: string; password?: string }) {
    setFormError(null);
    setSubmitting(true);
    try {
      await api("/invites/accept", { method: "POST", body, redirectOn401: false });
      router.push("/app/contacts");
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.code === "login_required") {
        setFormError(
          <>
            Please{" "}
            <Link href={loginUrl(invitePath)} className="font-medium underline">
              sign in
            </Link>{" "}
            to accept this invite.
          </>,
        );
      } else if (err instanceof ApiError && goneCodes[err.code]) {
        setFormError(goneCodes[err.code]);
      } else {
        const fe = fieldErrorsFrom(err);
        setErrors(fe);
        setFormError(
          Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
        );
      }
    }
  }

  function onSubmitNew(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Required";
    const pw = PasswordSchema.safeParse(password);
    if (!pw.success) next.password = pw.error.issues[0]?.message ?? "Invalid password";
    setErrors(next);
    if (Object.keys(next).length) return;
    void accept({ token, name: name.trim(), password });
  }

  if (loadError) {
    return (
      <AuthShell title="Invite not found">
        <Alert tone="error">{loadError}</Alert>
        <Link href="/login" className={`${buttonClasses("secondary")} mt-6 w-full`}>
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  if (!invite) {
    return (
      <AuthShell title="Join workspace">
        <LoadingBlock label="Checking your invite" />
      </AuthShell>
    );
  }

  const subtitle = (
    <>
      You&apos;ve been invited to{" "}
      <strong className="text-slate-900 dark:text-white">{invite.workspaceName}</strong> as{" "}
      <RoleBadge role={invite.role} />
    </>
  );

  if (invite.status !== "valid") {
    return (
      <AuthShell title={`Join ${invite.workspaceName}`} subtitle={subtitle}>
        <Alert tone="warning">{statusMessages[invite.status]}</Alert>
        <Link href="/login" className={`${buttonClasses("secondary")} mt-6 w-full`}>
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  if (invite.accountExists) {
    const signedInAsInvitee = me && me.user.email.toLowerCase() === invite.email.toLowerCase();
    return (
      <AuthShell title={`Join ${invite.workspaceName}`} subtitle={subtitle}>
        <div className="space-y-4">
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          {signedInAsInvitee ? (
            <>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                You&apos;re signed in as <strong>{me.user.email}</strong>.
              </p>
              <Button
                className="w-full"
                loading={submitting}
                onClick={() => void accept({ token })}
              >
                Accept invite
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                Sign in as <strong>{invite.email}</strong> to accept.
                {me ? <> You&apos;re currently signed in as {me.user.email}.</> : null}
              </p>
              <Link href={loginUrl(invitePath)} className={`${buttonClasses("primary")} w-full`}>
                Sign in as {invite.email}
              </Link>
            </>
          )}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`Join ${invite.workspaceName}`} subtitle={subtitle}>
      <form onSubmit={onSubmitNew} noValidate className="space-y-4">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field label="Email">
          {(p) => <Input {...p} type="email" value={invite.email} readOnly disabled />}
        </Field>
        <Field label="Your name" error={errors.name} required>
          {(p) => (
            <Input
              {...p}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Password" hint="At least 12 characters" error={errors.password} required>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        <Button type="submit" className="w-full" loading={submitting}>
          Create account and join
        </Button>
      </form>
    </AuthShell>
  );
}
