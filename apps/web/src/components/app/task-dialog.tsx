"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  CreateTaskInputSchema,
  TASK_KINDS,
  UpdateTaskInputSchema,
  type ContactListDto,
  type MemberDto,
  type TaskDto,
  type TaskKind,
} from "@openline/shared";
import {
  Alert,
  Button,
  cx,
  Dialog,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import { contactName, zodFieldErrors } from "@/lib/format";
import {
  fromLocalParts,
  notifyTasksChanged,
  TASK_KIND_LABELS,
  taskContactName,
  toLocalParts,
  viewerTimeZone,
} from "@/lib/tasks";
import { useDebounced, useResource } from "@/lib/use-resource";
import { useMe } from "./me-context";

export interface PickedContact {
  id: string;
  name: string;
  email: string;
  /** The contact's company, when known (deal dialog uses it). */
  company?: { id: string; name: string } | null;
}

/** Search-as-you-type contact picker (radio list), optional. */
export function ContactPicker({
  value,
  onChange,
  disabled,
  error,
  legend = "Contact (optional)",
  hint = "Link the task to a contact so it shows on their page.",
}: {
  value: PickedContact | null;
  onChange: (c: PickedContact | null) => void;
  disabled?: boolean;
  error?: string;
  legend?: string;
  hint?: string;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const list = useResource<ContactListDto>("/contacts", { q: q || undefined, limit: 6 });
  const options = (list.data?.items ?? []).map((c) => ({
    id: c.id,
    name: contactName(c),
    email: c.email,
    company: c.company ? { id: c.company.id, name: c.company.name } : null,
  }));

  return (
    <fieldset aria-describedby={error ? `${id}-err` : `${id}-hint`}>
      <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">{legend}</legend>
      <p id={`${id}-hint`} className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
        {value ? (
          <>
            Linked to <strong>{value.name}</strong>.{" "}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(null)}
              className="rounded font-medium text-indigo-700 underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300"
            >
              Remove contact
            </button>
          </>
        ) : (
          hint
        )}
      </p>
      <label htmlFor={`${id}-search`} className="sr-only">
        Search contacts
      </label>
      <Input
        id={`${id}-search`}
        type="search"
        className="mt-2"
        placeholder="Search by name, email or company"
        value={search}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="mt-2 min-h-12" aria-live="polite">
        {list.loading && !list.data ? (
          <p className="flex items-center gap-2 py-2 text-sm text-slate-600 dark:text-slate-400">
            <Spinner size="sm" label="" /> Loading contacts…
          </p>
        ) : list.error ? (
          <p className="py-2 text-sm text-red-700 dark:text-red-400">{errorMessage(list.error)}</p>
        ) : options.length === 0 ? (
          <p className="py-2 text-sm text-slate-600 dark:text-slate-400">
            {q ? "No contacts match." : "No contacts yet."}
          </p>
        ) : (
          <ul className="space-y-1">
            {options.map((o) => {
              const checked = value?.id === o.id;
              return (
                <li key={o.id}>
                  <label
                    className={cx(
                      "flex cursor-pointer items-center gap-3 rounded-lg border p-2 text-sm focus-within:ring-2 focus-within:ring-indigo-600",
                      checked
                        ? "border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950"
                        : "border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${id}-contact`}
                      checked={checked}
                      disabled={disabled}
                      onChange={() => onChange(o)}
                      className="accent-indigo-600"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-slate-900 dark:text-slate-100">
                        {o.name}
                      </span>
                      {o.name !== o.email ? (
                        <span className="block truncate text-xs text-slate-600 dark:text-slate-400">
                          {o.email}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {error ? (
        <p id={`${id}-err`} className="mt-1 text-xs font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Create a task, or edit one (title, kind, due date and time, contact, notes, owner). */
export function TaskDialog({
  open,
  onClose,
  task,
  fixedContact,
  fixedDeal,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Edit this task; omit to create one. */
  task?: TaskDto | null;
  /** Create the task for this contact (contact page): no picker. */
  fixedContact?: PickedContact;
  /** Link a new task to this deal (deal page). */
  fixedDeal?: { id: string; name: string };
  onSaved: (t: TaskDto) => void;
}) {
  const { me, can } = useMe();
  const isManager = can("owner", "admin", "manager");
  const members = useResource<MemberDto[]>(open && isManager ? "/members" : null);
  const formId = useId();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<TaskKind>("other");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Callers pass a fresh object each render; reset the form only when it opens.
  const fixedRef = useRef(fixedContact);
  fixedRef.current = fixedContact;

  useEffect(() => {
    if (!open) return;
    const fixed = fixedRef.current;
    const parts = toLocalParts(task?.dueAt);
    setTitle(task?.title ?? "");
    setKind(task?.kind ?? "other");
    setDate(parts.date);
    setTime(parts.time);
    setNotes(task?.notes ?? "");
    setOwnerId(task?.owner.id ?? me.user.id);
    setContact(
      task?.contact
        ? { id: task.contact.id, name: taskContactName(task.contact), email: task.contact.email }
        : (fixed ?? null),
    );
    setErrors({});
    setFormError(null);
  }, [open, task, me.user.id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const dueAt = fromLocalParts(date, time);
    if (dueAt === undefined) {
      setErrors({ dueAt: "Enter a valid date and time" });
      return;
    }
    const body = task
      ? {
          ...(title !== task.title ? { title } : {}),
          ...(kind !== task.kind ? { kind } : {}),
          ...(dueAt !== (task.dueAt ? new Date(task.dueAt).toISOString() : null) ? { dueAt } : {}),
          ...(notes.trim() !== (task.notes ?? "") ? { notes: notes.trim() || null } : {}),
          ...((contact?.id ?? null) !== (task.contact?.id ?? null)
            ? { contactId: contact?.id ?? null }
            : {}),
          ...(isManager && ownerId !== task.owner.id ? { ownerId } : {}),
        }
      : {
          title,
          kind,
          dueAt,
          notes: notes.trim() || undefined,
          contactId: contact?.id,
          dealId: fixedDeal?.id,
          ownerId: isManager && ownerId !== me.user.id ? ownerId : undefined,
        };
    if (task && Object.keys(body).length === 0) {
      onClose();
      return;
    }
    const parsed = task
      ? UpdateTaskInputSchema.safeParse(body)
      : CreateTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const saved = await api<TaskDto>(task ? `/tasks/${task.id}` : "/tasks", {
        method: task ? "PATCH" : "POST",
        body: parsed.data,
      });
      notifyTasksChanged();
      onSaved(saved);
      onClose();
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      setErrors(fe);
      if (err instanceof ApiError && err.code === "task_closed") {
        setFormError("This task was closed in the meantime, so it can't be edited.");
      } else {
        setFormError(
          Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={task ? "Edit task" : "New task"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {task ? "Save task" : "Create task"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-4">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field label="Title" error={errors.title} required>
          {(p) => (
            <Input
              {...p}
              value={title}
              maxLength={200}
              disabled={saving}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Kind" error={errors.kind}>
          {(p) => (
            <Select
              {...p}
              value={kind}
              disabled={saving}
              onChange={(e) => setKind(e.target.value as TaskKind)}
            >
              {TASK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TASK_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due date" error={errors.dueAt} hint="Leave empty for no due date.">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={date}
                disabled={saving}
                onChange={(e) => setDate(e.target.value)}
              />
            )}
          </Field>
          <Field label="Due time" hint={`Your time zone (${viewerTimeZone()}). Default 5:00 PM.`}>
            {(p) => (
              <Input
                {...p}
                type="time"
                value={time}
                disabled={saving || !date}
                onChange={(e) => setTime(e.target.value)}
              />
            )}
          </Field>
        </div>
        {isManager ? (
          <Field label="Owner" error={errors.ownerId}>
            {(p) => (
              <Select
                {...p}
                value={ownerId}
                disabled={saving || members.loading}
                onChange={(e) => setOwnerId(e.target.value)}
              >
                {(members.data ?? [{ userId: me.user.id, name: me.user.name, email: "" }]).map(
                  (m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.userId === me.user.id ? `${m.name} (you)` : m.name}
                    </option>
                  ),
                )}
              </Select>
            )}
          </Field>
        ) : null}
        {fixedDeal && !task ? (
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Linked to the deal <strong>{fixedDeal.name}</strong>
          </p>
        ) : null}
        {fixedContact && !task ? (
          <p className="text-sm text-slate-700 dark:text-slate-300">
            For <strong>{fixedContact.name}</strong>
          </p>
        ) : (
          <ContactPicker
            value={contact}
            onChange={setContact}
            disabled={saving}
            error={errors.contactId}
          />
        )}
        <Field label="Notes (optional)" error={errors.notes}>
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              maxLength={2_000}
              value={notes}
              disabled={saving}
              onChange={(e) => setNotes(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
