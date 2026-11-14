"use client";

import { useState, type FormEvent } from "react";
import { SuppressionCreateSchema, type SuppressionDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Select,
  Table,
  Td,
  Th,
  useToast,
  type BadgeTone,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { formatDate, zodFieldErrors } from "@/lib/format";
import { useResource } from "@/lib/use-resource";

type Reason = SuppressionDto["reason"];

const REASONS: { value: string; label: string; tone: BadgeTone }[] = [
  { value: "unsubscribed", label: "Unsubscribed", tone: "warning" },
  { value: "asked_not_to_contact", label: "Asked not to contact", tone: "warning" },
  { value: "bounced", label: "Bounced", tone: "danger" },
  { value: "competitor", label: "Competitor", tone: "neutral" },
  { value: "other", label: "Other", tone: "neutral" },
];

const LOCKED_REASONS = new Set<Reason>(["unsubscribed", "asked_not_to_contact"]);

function reasonInfo(reason: Reason) {
  return (
    REASONS.find((r) => r.value === reason) ?? {
      value: reason,
      label: reason,
      tone: "neutral" as const,
    }
  );
}

export default function SuppressionsPage() {
  const { can } = useMe();
  const { toast } = useToast();
  const canManage = can("owner", "admin");
  const { data, error, loading, setData, reload } = useResource<SuppressionDto[]>("/suppressions");

  const [value, setValue] = useState("");
  const [reason, setReason] = useState("other");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SuppressionDto | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = SuppressionCreateSchema.safeParse({ value, reason });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setAdding(true);
    try {
      const created = await api<SuppressionDto>("/suppressions", {
        method: "POST",
        body: parsed.data,
      });
      setData((prev) => [created, ...(prev ?? [])]);
      setValue("");
      toast(`${created.value} will never be contacted`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "conflict") {
        setErrors({ value: "This is already on the suppression list." });
      } else {
        const fe = fieldErrorsFrom(err);
        setErrors(fe);
        setFormError(
          Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
        );
      }
    } finally {
      setAdding(false);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api(`/suppressions/${removing.id}`, { method: "DELETE" });
      setData((prev) => prev?.filter((s) => s.id !== removing.id));
      toast(`Removed ${removing.value} from suppressions`);
      setRemoving(null);
    } catch (err) {
      setRemoveError(
        err instanceof ApiError && err.code === "suppression_locked"
          ? "This entry is locked. People who unsubscribed or asked not to be contacted stay suppressed — removing them would break anti-spam law."
          : errorMessage(err),
      );
    } finally {
      setRemoveBusy(false);
    }
  }

  const needle = filter.trim().toLowerCase();
  const rows = (data ?? []).filter((s) => !needle || s.value.includes(needle));

  return (
    <>
      <PageHeader
        title="Suppressions"
        description="Emails and domains on this list are never contacted from this workspace — checked before every send."
      />

      <div className="space-y-6">
        {canManage ? (
          <Card>
            <CardHeader title="Add to suppression list" />
            <form onSubmit={onAdd} noValidate className="p-5">
              {formError ? (
                <Alert tone="error" className="mb-4">
                  {formError}
                </Alert>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-[1fr_14rem_auto] sm:items-start">
                <Field
                  label="Email or domain"
                  hint="jane@acme.com, or @acme.com for a whole domain"
                  error={errors.value}
                  required
                >
                  {(p) => (
                    <Input
                      {...p}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      autoComplete="off"
                      required
                    />
                  )}
                </Field>
                <Field label="Reason" error={errors.reason}>
                  {(p) => (
                    <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
                      {REASONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Button type="submit" loading={adding} className="sm:mt-6">
                  Add
                </Button>
              </div>
            </form>
          </Card>
        ) : (
          <Alert tone="info">Only owners and admins can change the suppression list.</Alert>
        )}

        <Card>
          <CardHeader
            title="Suppressed"
            description={
              data
                ? `${data.length.toLocaleString()} entr${data.length === 1 ? "y" : "ies"}`
                : undefined
            }
            actions={
              data && data.length > 0 ? (
                <Input
                  type="search"
                  aria-label="Filter suppressions"
                  placeholder="Filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="h-9 w-56"
                />
              ) : null
            }
          />
          {loading && !data ? (
            <LoadingBlock label="Loading suppressions" />
          ) : error ? (
            <div className="p-4">
              <Alert tone="error">{errorMessage(error)}</Alert>
              <Button variant="secondary" size="sm" className="mt-3" onClick={reload}>
                Try again
              </Button>
            </div>
          ) : !data || data.length === 0 ? (
            <EmptyState
              title="Nothing suppressed yet"
              description="Unsubscribes and bounces land here automatically once sending starts."
            />
          ) : rows.length === 0 ? (
            <EmptyState title="No matches" description={`Nothing matches “${filter}”.`} />
          ) : (
            <Table caption="Suppression list">
              <thead>
                <tr>
                  <Th>Email or domain</Th>
                  <Th>Reason</Th>
                  <Th>Added</Th>
                  {canManage ? (
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const info = reasonInfo(s.reason);
                  return (
                    <tr key={s.id}>
                      <Td className="font-mono text-xs">{s.value}</Td>
                      <Td>
                        <Badge tone={info.tone}>{info.label}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                        {formatDate(s.createdAt)}
                      </Td>
                      {canManage ? (
                        <Td className="text-right">
                          {LOCKED_REASONS.has(s.reason) ? (
                            <span
                              className="text-xs text-slate-500 dark:text-slate-400"
                              title="Opt-outs can't be removed"
                            >
                              Locked
                            </span>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setRemoveError(null);
                                setRemoving(s);
                              }}
                            >
                              Remove<span className="sr-only"> {s.value}</span>
                            </Button>
                          )}
                        </Td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title="Remove from suppression list?"
        description={
          removing ? `${removing.value} could be contacted again from this workspace.` : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)} disabled={removeBusy}>
              Cancel
            </Button>
            <Button variant="danger" loading={removeBusy} onClick={() => void confirmRemove()}>
              Remove
            </Button>
          </>
        }
      >
        {removeError ? <Alert tone="warning">{removeError}</Alert> : null}
      </Dialog>
    </>
  );
}
