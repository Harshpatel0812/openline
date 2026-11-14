"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import {
  InviteInputSchema,
  ROLES,
  type InviteDto,
  type MemberDto,
  type Role,
} from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import {
  Alert,
  Avatar,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  RoleBadge,
  Select,
  Table,
  Td,
  Th,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { formatDate, zodFieldErrors } from "@/lib/format";
import { useResource } from "@/lib/use-resource";

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  rep: "Rep",
};

const INVITE_ROLES = ["rep", "manager", "admin"] as const;

function teamError(err: unknown): string {
  if (err instanceof ApiError && err.code === "last_owner") {
    return "A workspace needs at least one owner. Make someone else an owner first.";
  }
  if (err instanceof ApiError && err.status === 403) {
    return "You don't have permission to do that. Only owners can change or remove other owners.";
  }
  return errorMessage(err);
}

function InviteDialog({
  open,
  onClose,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof INVITE_ROLES)[number]>("rep");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const formId = useId();
  const linkId = useId();

  useEffect(() => {
    if (open) {
      setEmail("");
      setRole("rep");
      setErrors({});
      setFormError(null);
      setInviteUrl(null);
      setCopied(false);
    }
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = InviteInputSchema.safeParse({ email, role });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const res = await api<{ invite: InviteDto; inviteUrl: string }>("/invites", {
        method: "POST",
        body: parsed.data,
      });
      setInviteUrl(res.inviteUrl);
      onInvited();
    } catch (err) {
      if (err instanceof ApiError && err.code === "already_member") {
        setErrors({ email: "This person is already a member of this workspace." });
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

  async function copy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      const input = document.getElementById(linkId);
      if (input instanceof HTMLInputElement) input.select();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={inviteUrl ? "Invite created" : "Invite teammate"}
      footer={
        inviteUrl ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={saving}>
              Create invite
            </Button>
          </>
        )
      }
    >
      {inviteUrl ? (
        <div className="space-y-4">
          <Alert tone="info">Email invites are coming soon — share this link.</Alert>
          <div className="space-y-1.5">
            <label htmlFor={linkId} className="block text-sm font-medium">
              Invite link for {email}
            </label>
            <div className="flex gap-2">
              <Input
                id={linkId}
                value={inviteUrl}
                readOnly
                onFocus={(e) => e.target.select()}
                className="font-mono text-xs"
              />
              <Button variant="secondary" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400" aria-live="polite">
              {copied ? "Link copied to clipboard. " : ""}This link is shown only once.
            </p>
          </div>
        </div>
      ) : (
        <form id={formId} onSubmit={onSubmit} noValidate className="space-y-4">
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <Field label="Email" error={errors.email} required>
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            )}
          </Field>
          <Field
            label="Role"
            error={errors.role}
            hint="Admins manage the team and suppressions. Managers can delete contacts."
          >
            {(p) => (
              <Select
                {...p}
                value={role}
                onChange={(e) => setRole(e.target.value as (typeof INVITE_ROLES)[number])}
              >
                {INVITE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </form>
      )}
    </Dialog>
  );
}

export default function TeamPage() {
  const { me, can } = useMe();
  const { toast } = useToast();
  const canManage = can("owner", "admin");
  const members = useResource<MemberDto[]>("/members");
  const invites = useResource<InviteDto[]>(canManage ? "/invites" : null);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<MemberDto | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [roleBusy, setRoleBusy] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function changeRole(member: MemberDto, role: Role) {
    if (role === member.role) return;
    setRoleBusy(member.userId);
    try {
      await api(`/members/${member.userId}`, { method: "PATCH", body: { role } });
      members.setData((prev) =>
        prev?.map((m) => (m.userId === member.userId ? { ...m, role } : m)),
      );
      toast(
        `${member.name} is now ${ROLE_LABELS[role].toLowerCase() === "admin" ? "an admin" : `a ${ROLE_LABELS[role].toLowerCase()}`}`,
      );
    } catch (err) {
      toast(teamError(err), "error");
    } finally {
      setRoleBusy(null);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api(`/members/${removing.userId}`, { method: "DELETE" });
      if (removing.userId === me.user.id) {
        window.location.assign("/app");
        return;
      }
      members.setData((prev) => prev?.filter((m) => m.userId !== removing.userId));
      toast(`Removed ${removing.name} from ${me.workspace.name}`);
      setRemoving(null);
    } catch (err) {
      setRemoveError(teamError(err));
    } finally {
      setRemoveBusy(false);
    }
  }

  async function revoke(invite: InviteDto) {
    setRevoking(invite.id);
    try {
      await api(`/invites/${invite.id}`, { method: "DELETE" });
      invites.setData((prev) => prev?.filter((i) => i.id !== invite.id));
      toast(`Revoked invite for ${invite.email}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setRevoking(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Team"
        description={`People who can access ${me.workspace.name}.`}
        actions={
          canManage ? <Button onClick={() => setInviting(true)}>Invite teammate</Button> : null
        }
      />

      <div className="space-y-6">
        <Card>
          <CardHeader title="Members" />
          {members.loading && !members.data ? (
            <LoadingBlock label="Loading members" />
          ) : members.error ? (
            <div className="p-4">
              <Alert tone="error">{errorMessage(members.error)}</Alert>
            </div>
          ) : (
            <Table caption="Workspace members">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Joined</Th>
                  {canManage ? (
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {(members.data ?? []).map((m) => {
                  const isSelf = m.userId === me.user.id;
                  // Admins can't manage owners; the API enforces this too.
                  const ownerCount = (members.data ?? []).filter((x) => x.role === "owner").length;
                  const isLastOwner = m.role === "owner" && ownerCount <= 1;
                  const editable = canManage && (me.role === "owner" || m.role !== "owner");
                  return (
                    <tr key={m.userId}>
                      <Td>
                        <div className="flex items-center gap-3">
                          <Avatar name={m.name || m.email} size="sm" />
                          <span className="font-medium">
                            {m.name}
                            {isSelf ? (
                              <span className="ml-1 text-slate-500 dark:text-slate-400">(you)</span>
                            ) : null}
                          </span>
                        </div>
                      </Td>
                      <Td className="text-slate-600 dark:text-slate-400">{m.email}</Td>
                      <Td>
                        {editable ? (
                          <Select
                            aria-label={`Role for ${m.name}`}
                            value={m.role}
                            disabled={roleBusy === m.userId}
                            onChange={(e) => void changeRole(m, e.target.value as Role)}
                            className="h-8 w-32"
                          >
                            {ROLES.filter((r) => me.role === "owner" || r !== "owner").map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <RoleBadge role={m.role} />
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                        {formatDate(m.joinedAt)}
                      </Td>
                      {canManage ? (
                        <Td className="text-right">
                          {editable && !isLastOwner ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setRemoveError(null);
                                setRemoving(m);
                              }}
                            >
                              {isSelf ? "Leave" : "Remove"}
                              <span className="sr-only"> {m.name}</span>
                            </Button>
                          ) : null}
                        </Td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>

        {canManage ? (
          <Card>
            <CardHeader
              title="Pending invites"
              description="Invites expire if they aren't accepted in time."
            />
            {invites.loading && !invites.data ? (
              <LoadingBlock label="Loading invites" />
            ) : invites.error ? (
              <div className="p-4">
                <Alert tone="error">{errorMessage(invites.error)}</Alert>
              </div>
            ) : !invites.data || invites.data.length === 0 ? (
              <EmptyState
                title="No pending invites"
                action={
                  <Button variant="secondary" onClick={() => setInviting(true)}>
                    Invite teammate
                  </Button>
                }
              />
            ) : (
              <Table caption="Pending invites">
                <thead>
                  <tr>
                    <Th>Email</Th>
                    <Th>Role</Th>
                    <Th>Sent</Th>
                    <Th>Expires</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {invites.data.map((i) => (
                    <tr key={i.id}>
                      <Td className="font-medium">{i.email}</Td>
                      <Td>
                        <RoleBadge role={i.role} />
                      </Td>
                      <Td className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                        {formatDate(i.createdAt)}
                      </Td>
                      <Td className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                        {formatDate(i.expiresAt)}
                      </Td>
                      <Td className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={revoking === i.id}
                          onClick={() => void revoke(i)}
                        >
                          Revoke<span className="sr-only"> invite for {i.email}</span>
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        ) : null}
      </div>

      <InviteDialog open={inviting} onClose={() => setInviting(false)} onInvited={invites.reload} />

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title={
          removing?.userId === me.user.id
            ? "Leave this workspace?"
            : `Remove ${removing?.name ?? ""}?`
        }
        description={
          removing?.userId === me.user.id
            ? `You'll lose access to ${me.workspace.name} until someone invites you again.`
            : `${removing?.name ?? "They"} will lose access to ${me.workspace.name} immediately. Their contacts stay in the workspace.`
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)} disabled={removeBusy}>
              Cancel
            </Button>
            <Button variant="danger" loading={removeBusy} onClick={() => void confirmRemove()}>
              {removing?.userId === me.user.id ? "Leave workspace" : "Remove member"}
            </Button>
          </>
        }
      >
        {removeError ? <Alert tone="error">{removeError}</Alert> : null}
      </Dialog>
    </>
  );
}
