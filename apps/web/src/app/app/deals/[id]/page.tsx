"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  PIPELINE_LIMITS,
  toMinorUnits,
  UpdateDealInputSchema,
  type DealDetailDto,
  type DealTimelineDto,
  type DealTimelineItemDto,
  type MemberDto,
  type PipelineStageDto,
  type TaskDto,
} from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import {
  DealBadges,
  LostReasonDialog,
  moveDeal,
  moveErrorMessage,
  StageKindBadge,
} from "@/components/app/deal-parts";
import { CrmBadge } from "@/components/app/crm-badge";
import { useMe } from "@/components/app/me-context";
import { RealityCheckPanel } from "@/components/app/reality-check";
import { ContactPicker, TaskDialog, type PickedContact } from "@/components/app/task-dialog";
import { TaskList } from "@/components/app/task-list";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  Field,
  Input,
  Label,
  LoadingBlock,
  Select,
  Spinner,
  Textarea,
  useToast,
} from "@/components/ui";
import { api, ApiError, errorMessage, fieldErrorsFrom } from "@/lib/api";
import {
  currencyOptions,
  dealContactName,
  formatCalendarDate,
  formatMoney,
  minorToInput,
  notifyDealsChanged,
  stageOrder,
} from "@/lib/deals";
import { crmOf } from "@/lib/crm";
import { zodFieldErrors } from "@/lib/format";
import { fullDateTime, relativeTime } from "@/lib/inbox";
import { TASKS_CHANGED_EVENT } from "@/lib/tasks";
import { useResource } from "@/lib/use-resource";

const sectionTitle =
  "text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400";

// ------------------------------------------------------------------ details form

interface Values {
  name: string;
  amount: string;
  currency: string;
  expectedCloseDate: string;
  nextStep: string;
  nextStepDate: string;
  ownerId: string;
  lostReason: string;
}

const fromDeal = (d: DealDetailDto): Values => ({
  name: d.name,
  amount: minorToInput(d.amountMinor, d.currency),
  currency: d.currency,
  expectedCloseDate: d.expectedCloseDate ?? "",
  nextStep: d.nextStep ?? "",
  nextStepDate: d.nextStepDate ?? "",
  ownerId: d.owner.id,
  lostReason: d.lostReason ?? "",
});

function DetailsCard({
  deal,
  onSaved,
}: {
  deal: DealDetailDto;
  onSaved: (d: DealDetailDto) => void;
}) {
  const { can, me } = useMe();
  const { toast } = useToast();
  const isManager = can("owner", "admin", "manager");
  const members = useResource<MemberDto[]>(isManager ? "/members" : null);
  const [values, setValues] = useState<Values>(() => fromDeal(deal));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValues(fromDeal(deal)), [deal]);

  const initial = fromDeal(deal);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  const disabled = !deal.canEdit || saving;
  const set = (k: keyof Values) => (v: string) => setValues((p) => ({ ...p, [k]: v }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const local: Record<string, string> = {};
    let amountMinor: number | null = null;
    if (values.amount.trim()) {
      amountMinor = toMinorUnits(values.amount, values.currency);
      if (amountMinor === null) local.amountMinor = "Enter an amount like 12500 or 12500.50";
    }
    const body: Record<string, unknown> = {};
    if (values.name !== initial.name) body.name = values.name;
    if (values.amount !== initial.amount || values.currency !== initial.currency) {
      body.amountMinor = amountMinor;
      if (values.currency !== initial.currency) body.currency = values.currency;
    }
    if (values.expectedCloseDate !== initial.expectedCloseDate) {
      body.expectedCloseDate = values.expectedCloseDate || null;
    }
    if (values.nextStep !== initial.nextStep) body.nextStep = values.nextStep.trim() || null;
    if (values.nextStepDate !== initial.nextStepDate) {
      body.nextStepDate = values.nextStepDate || null;
    }
    if (isManager && values.ownerId !== initial.ownerId) body.ownerId = values.ownerId;
    if (deal.stage.kind === "lost" && values.lostReason !== initial.lostReason) {
      body.lostReason = values.lostReason;
    }
    if (Object.keys(body).length === 0 && !Object.keys(local).length) return;
    const parsed = UpdateDealInputSchema.safeParse(body);
    const all = { ...(parsed.success ? {} : zodFieldErrors(parsed.error.issues)), ...local };
    if (Object.keys(all).length || !parsed.success) {
      setErrors(all);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const saved = await api<DealDetailDto>(`/deals/${deal.id}`, {
        method: "PATCH",
        body: parsed.data,
      });
      onSaved(saved);
      notifyDealsChanged();
      toast("Deal saved");
    } catch (err) {
      const fe = fieldErrorsFrom(err);
      setErrors(fe);
      setFormError(
        Object.keys(fe).length ? "Please fix the highlighted fields." : errorMessage(err),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Details" />
      <form onSubmit={onSubmit} noValidate className="space-y-4 p-5">
        {!deal.canEdit ? (
          <Alert tone="info">
            Only {deal.owner.name} (the owner) or a manager can change this deal.
          </Alert>
        ) : null}
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field label="Deal name" error={errors.name} required>
          {(p) => (
            <Input
              {...p}
              value={values.name}
              maxLength={PIPELINE_LIMITS.dealName}
              disabled={disabled}
              onChange={(e) => set("name")(e.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label="Amount" error={errors.amountMinor} hint="Leave empty for no amount.">
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={values.amount}
                disabled={disabled}
                onChange={(e) => set("amount")(e.target.value)}
              />
            )}
          </Field>
          <Field label="Currency" error={errors.currency}>
            {(p) => (
              <Select
                {...p}
                value={values.currency}
                disabled={disabled}
                onChange={(e) => set("currency")(e.target.value)}
              >
                {currencyOptions(values.currency).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expected close date" error={errors.expectedCloseDate}>
            {(p) => (
              <Input
                {...p}
                type="date"
                value={values.expectedCloseDate}
                disabled={disabled}
                onChange={(e) => set("expectedCloseDate")(e.target.value)}
              />
            )}
          </Field>
          {isManager ? (
            <Field label="Owner" error={errors.ownerId}>
              {(p) => (
                <Select
                  {...p}
                  value={values.ownerId}
                  disabled={disabled || members.loading}
                  onChange={(e) => set("ownerId")(e.target.value)}
                >
                  {(members.data ?? [{ userId: deal.owner.id, name: deal.owner.name }]).map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.userId === me.user.id ? `${m.name} (you)` : m.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field label="Next step" error={errors.nextStep}>
            {(p) => (
              <Input
                {...p}
                value={values.nextStep}
                maxLength={PIPELINE_LIMITS.nextStep}
                disabled={disabled}
                placeholder="Send the security questionnaire"
                onChange={(e) => set("nextStep")(e.target.value)}
              />
            )}
          </Field>
          <Field label="Next step date" error={errors.nextStepDate}>
            {(p) => (
              <Input
                {...p}
                type="date"
                value={values.nextStepDate}
                disabled={disabled}
                onChange={(e) => set("nextStepDate")(e.target.value)}
              />
            )}
          </Field>
        </div>
        {deal.stage.kind === "lost" ? (
          <Field label="Lost reason" error={errors.lostReason}>
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={values.lostReason}
                maxLength={PIPELINE_LIMITS.lostReason}
                disabled={disabled}
                onChange={(e) => set("lostReason")(e.target.value)}
              />
            )}
          </Field>
        ) : null}
        {deal.canEdit ? (
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              disabled={!dirty || saving}
              onClick={() => {
                setValues(initial);
                setErrors({});
                setFormError(null);
              }}
            >
              Discard changes
            </Button>
            <Button type="submit" loading={saving} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------ contacts

function ContactsCard({
  deal,
  onSaved,
}: {
  deal: DealDetailDto;
  onSaved: (d: DealDetailDto) => void;
}) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<PickedContact | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const full = deal.contacts.length >= PIPELINE_LIMITS.maxContacts;

  async function save(contactIds: string[], primaryContactId?: null, label?: string) {
    setError(null);
    try {
      const saved = await api<DealDetailDto>(`/deals/${deal.id}`, {
        method: "PATCH",
        body: primaryContactId === null ? { contactIds, primaryContactId } : { contactIds },
      });
      onSaved(saved);
      notifyDealsChanged();
      if (label) toast(label);
      return true;
    } catch (err) {
      setError(fieldErrorsFrom(err).contactIds ?? errorMessage(err));
      return false;
    }
  }

  async function remove(id: string, name: string) {
    setBusy(id);
    const isPrimary = deal.primaryContact?.id === id;
    await save(
      deal.contacts.filter((c) => c.id !== id).map((c) => c.id),
      isPrimary ? null : undefined,
      `Removed ${name} from the deal`,
    );
    setBusy(null);
  }

  async function add() {
    if (!picked) return;
    if (deal.contacts.some((c) => c.id === picked.id)) {
      setError(`${picked.name} is already on this deal.`);
      return;
    }
    setBusy("add");
    const ok = await save(
      [...deal.contacts.map((c) => c.id), picked.id],
      undefined,
      `Added ${picked.name} to the deal`,
    );
    setBusy(null);
    if (ok) {
      setAdding(false);
      setPicked(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Contacts"
        description={`${deal.contacts.length} of ${PIPELINE_LIMITS.maxContacts}. Emails with them count as deal activity.`}
        actions={
          deal.canEdit ? (
            <Button
              size="sm"
              variant="secondary"
              className="whitespace-nowrap"
              disabled={full}
              onClick={() => {
                setPicked(null);
                setError(null);
                setAdding(true);
              }}
            >
              Add contact
            </Button>
          ) : null
        }
      />
      {error && !adding ? (
        <div className="px-5 pt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}
      {full && deal.canEdit ? (
        <p className="px-5 pt-3 text-xs text-slate-600 dark:text-slate-400">
          A deal can have up to {PIPELINE_LIMITS.maxContacts} contacts. Remove one to add another.
        </p>
      ) : null}
      {deal.contacts.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-600 dark:text-slate-400">No contacts yet.</p>
      ) : (
        <ul
          aria-label="Contacts on this deal"
          className="divide-y divide-slate-200 dark:divide-slate-800"
        >
          {deal.contacts.map((c) => {
            const name = dealContactName(c);
            return (
              <li key={c.id} className="flex items-center gap-3 px-5 py-3">
                <Avatar name={name} size="sm" />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/app/contacts/${c.id}`}
                    className="block truncate text-sm font-medium text-slate-900 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-slate-100"
                  >
                    {name}
                  </Link>
                  <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                    {c.title ? `${c.title} · ` : ""}
                    {c.email}
                  </p>
                </div>
                {deal.primaryContact?.id === c.id ? <Badge tone="accent">Primary</Badge> : null}
                {deal.canEdit ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === c.id}
                    disabled={busy !== null}
                    onClick={() => void remove(c.id, name)}
                    aria-label={`Remove ${name} from the deal`}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a contact to this deal"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)} disabled={busy === "add"}>
              Cancel
            </Button>
            <Button disabled={!picked} loading={busy === "add"} onClick={() => void add()}>
              Add contact
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <ContactPicker
            value={picked}
            onChange={setPicked}
            legend="Contact"
            hint="Pick someone involved in this deal."
          />
        </div>
      </Dialog>
    </Card>
  );
}

// ------------------------------------------------------------------ timeline

function TimelineItem({ item }: { item: DealTimelineItemDto }) {
  const when = (
    <time
      dateTime={item.at}
      title={fullDateTime(item.at)}
      className="text-xs text-slate-600 dark:text-slate-400"
    >
      {relativeTime(item.at)}
    </time>
  );
  switch (item.kind) {
    case "email":
      return (
        <li
          id={`timeline-msg-${item.messageId}`}
          className="scroll-mt-24 px-5 py-3 target:bg-indigo-50 dark:target:bg-indigo-950"
        >
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={item.direction === "inbound" ? "info" : "neutral"}>
              {item.direction === "inbound" ? "Reply received" : "Email sent"}
            </Badge>
            {item.teammateMailbox ? (
              // Same rule as the inbox: a teammate's mail shows only direction and date.
              <span className="text-slate-700 italic dark:text-slate-300">
                Email (in a teammate&apos;s mailbox)
              </span>
            ) : item.direction === "inbound" ? (
              <Link
                href={`/app/inbox?view=all&message=${item.messageId}`}
                className="font-medium break-words text-indigo-700 hover:underline dark:text-indigo-300"
              >
                {item.subject || "(no subject)"}
              </Link>
            ) : (
              <span className="font-medium break-words text-slate-900 dark:text-slate-100">
                {item.subject || "(no subject)"}
              </span>
            )}
            {when}
          </p>
          {item.snippet ? (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap text-slate-700 dark:text-slate-300">
              {item.snippet}
            </p>
          ) : null}
        </li>
      );
    case "stage_change":
      return (
        <li className="px-5 py-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-slate-900 dark:text-slate-100">
              {item.from ? (
                <>
                  Moved from <strong>{item.from.name}</strong> to <strong>{item.to.name}</strong>
                </>
              ) : (
                <>
                  Created in <strong>{item.to.name}</strong>
                </>
              )}
              {item.by ? ` by ${item.by.name}` : ""}
            </span>
            {when}
          </p>
        </li>
      );
    case "task":
      return (
        <li className="px-5 py-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={item.status === "done" ? "success" : "neutral"}>
              {item.status === "done"
                ? "Task done"
                : item.status === "open"
                  ? "Task"
                  : "Task dismissed"}
            </Badge>
            <span className="text-slate-900 dark:text-slate-100">
              {item.title ?? "A teammate's task"}
            </span>
            {when}
          </p>
        </li>
      );
    case "edit":
      return (
        <li className="px-5 py-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-slate-900 dark:text-slate-100">
              {item.by ? item.by.name : "Someone"} edited {item.fields.map(fieldLabel).join(", ")}
            </span>
            {when}
          </p>
        </li>
      );
  }
}

const FIELD_LABELS: Record<string, string> = {
  name: "the name",
  amountMinor: "the amount",
  currency: "the currency",
  expectedCloseDate: "the close date",
  nextStep: "the next step",
  nextStepDate: "the next step date",
  ownerId: "the owner",
  companyId: "the company",
  primaryContactId: "the primary contact",
  contactIds: "the contacts",
  lostReason: "the lost reason",
};
const fieldLabel = (f: string) => FIELD_LABELS[f] ?? f;

function TimelineCard({ dealId, version }: { dealId: string; version: string }) {
  const { data, error, loading, reload } = useResource<DealTimelineDto>(
    `/deals/${dealId}/timeline`,
  );
  const firstVersion = useRef(version);
  useEffect(() => {
    if (version !== firstVersion.current) reload();
  }, [version, reload]);
  return (
    <Card>
      <CardHeader
        title="Activity"
        description="Emails with the deal's contacts, stage changes, tasks and edits."
      />
      {loading && !data ? (
        <LoadingBlock label="Loading activity" />
      ) : error ? (
        <div className="space-y-2 p-5">
          <Alert tone="error">{errorMessage(error)}</Alert>
          <Button size="sm" variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : !data || data.items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-600 dark:text-slate-400">No activity yet.</p>
      ) : (
        <ol
          aria-label="Deal activity, newest first"
          className="divide-y divide-slate-200 dark:divide-slate-800"
        >
          {data.items.map((i) => (
            <TimelineItem key={`${i.kind}-${i.id}`} item={i} />
          ))}
        </ol>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ tasks

function DealTasksCard({ deal, onChanged }: { deal: DealDetailDto; onChanged: () => void }) {
  const { data, error, loading, reload } = useResource<TaskDto[]>("/tasks", {
    dealId: deal.id,
    status: "open",
    due: "any",
  });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TaskDto | null>(null);
  useEffect(() => {
    window.addEventListener(TASKS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, reload);
  }, [reload]);
  const contact = deal.primaryContact;
  return (
    <Card>
      <CardHeader
        title="Tasks"
        description="Your open tasks for this deal. Completing one counts as deal activity."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            Add task
          </Button>
        }
      />
      {loading && !data ? (
        <LoadingBlock label="Loading tasks" />
      ) : error ? (
        <div className="space-y-2 p-5">
          <Alert tone="error">{errorMessage(error)}</Alert>
          <Button size="sm" variant="secondary" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : !data || data.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-600 dark:text-slate-400">No open tasks.</p>
      ) : (
        <TaskList
          label={`Open tasks for ${deal.name}`}
          tasks={data}
          onChanged={() => {
            reload();
            onChanged();
          }}
          onEdit={setEditing}
        />
      )}
      <TaskDialog
        open={creating || editing !== null}
        task={editing}
        fixedDeal={{ id: deal.id, name: deal.name }}
        fixedContact={
          contact
            ? { id: contact.id, name: dealContactName(contact), email: contact.email }
            : undefined
        }
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          reload();
          onChanged();
        }}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ page

export default function DealPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const deal = useResource<DealDetailDto>(`/deals/${id}`);
  const stages = useResource<PipelineStageDto[]>("/pipeline/stages");
  const [pendingLost, setPendingLost] = useState<PipelineStageDto | null>(null);
  const [moving, setMoving] = useState(false);
  const [live, setLive] = useState("");
  const [bump, setBump] = useState(0);
  const stageSelectId = useId();
  const setDeal = deal.setData;

  if (deal.loading && !deal.data) return <LoadingBlock label="Loading deal" />;
  if (deal.error || !deal.data) {
    const notFound = deal.error instanceof ApiError && deal.error.status === 404;
    return (
      <div className="max-w-xl space-y-4">
        <Alert tone="error" title={notFound ? "Deal not found" : "Couldn't load this deal"}>
          {notFound
            ? "It may have been removed, or it belongs to a different workspace."
            : errorMessage(deal.error)}
        </Alert>
        <div className="flex gap-2">
          <Link
            href="/app/deals"
            className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-400"
          >
            ← Back to deals
          </Link>
          {!notFound ? (
            <Button variant="ghost" size="sm" onClick={deal.reload}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const d = deal.data;
  const ordered = stageOrder(stages.data ?? []);
  const version = `${d.updatedAt}-${d.stageEnteredAt}-${bump}`;

  function updated(next: DealDetailDto) {
    setDeal(() => next);
  }

  async function move(stage: PipelineStageDto, lostReason?: string) {
    const before = d;
    setMoving(true);
    setDeal((prev) =>
      prev
        ? {
            ...prev,
            stage: {
              id: stage.id,
              name: stage.name,
              kind: stage.kind,
              probability: stage.probability,
            },
          }
        : prev,
    );
    try {
      const saved = await moveDeal(d.id, stage.id, lostReason);
      setDeal(() => saved);
      setLive(`Moved to ${stage.name}.`);
      toast(`Moved to ${stage.name}`);
    } catch (err) {
      setDeal(() => before);
      const msg = `Couldn't move the deal: ${moveErrorMessage(err)}`;
      setLive(msg);
      toast(msg, "error");
    } finally {
      setMoving(false);
    }
  }

  function onStageChange(stageId: string) {
    const stage = ordered.find((s) => s.id === stageId);
    if (!stage || stage.id === d.stage.id) return;
    if (stage.kind === "lost") setPendingLost(stage);
    else void move(stage);
  }

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/app/deals" className="text-slate-600 hover:underline dark:text-slate-400">
          Deals
        </Link>
        <span aria-hidden="true" className="mx-2 text-slate-400">
          /
        </span>
        <span aria-current="page" className="text-slate-900 dark:text-slate-100">
          {d.name}
        </span>
      </nav>
      <PageHeader
        title={d.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {d.company ? (
              <Link
                href={`/app/companies/${d.company.id}`}
                className="font-medium text-indigo-700 hover:underline dark:text-indigo-300"
              >
                {d.company.name}
              </Link>
            ) : (
              <span>No company</span>
            )}
            <StageKindBadge kind={d.stage.kind} />
            <DealBadges deal={d} />
            <CrmBadge crm={crmOf(d)} label={d.name} />
          </span>
        }
        actions={
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={stageSelectId}>Stage</Label>
              <Select
                id={stageSelectId}
                value={d.stage.id}
                disabled={!d.canEdit || moving || !stages.data}
                onChange={(e) => onStageChange(e.target.value)}
                className="w-52"
              >
                {(ordered.length ? ordered : [{ ...d.stage, position: 0 }]).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.kind === "open" ? ` (${s.probability}%)` : ""}
                  </option>
                ))}
              </Select>
            </div>
            {moving ? <Spinner size="sm" label="Moving" /> : null}
          </div>
        }
      />
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>

      <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          {
            label: "Amount",
            value:
              formatMoney(d.amountMinor, d.currency) +
              (d.amountMinor !== null ? ` ${d.currency}` : ""),
          },
          { label: "Expected close", value: formatCalendarDate(d.expectedCloseDate) },
          { label: "Owner", value: d.owner.name },
          {
            label: "Next step",
            value: d.nextStep
              ? `${d.nextStep}${d.nextStepDate ? ` · ${formatCalendarDate(d.nextStepDate)}` : ""}`
              : "None",
          },
        ].map((i) => (
          <div
            key={i.label}
            className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
          >
            <dt className="text-xs font-medium text-slate-600 dark:text-slate-400">{i.label}</dt>
            <dd className="mt-0.5 text-sm font-semibold break-words text-slate-900 dark:text-white">
              {i.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <RealityCheckPanel deal={d} stages={ordered} onDealChanged={updated} version={version} />
          <DetailsCard deal={d} onSaved={updated} />
          <TimelineCard dealId={d.id} version={version} />
          <DealTasksCard deal={d} onChanged={() => setBump((n) => n + 1)} />
        </div>
        <div className="space-y-6">
          <ContactsCard deal={d} onSaved={updated} />
          <Card>
            <CardHeader title="Company" />
            <div className="px-5 py-4 text-sm">
              {d.company ? (
                <Link
                  href={`/app/companies/${d.company.id}`}
                  className="font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                >
                  {d.company.name}
                </Link>
              ) : (
                <p className="text-slate-600 dark:text-slate-400">No company on this deal.</p>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Stage history" />
            <ol aria-label="Stage history" className="space-y-3 px-5 py-4">
              {d.stageHistory.map((h) => (
                <li key={h.id} className="text-sm">
                  <p className="text-slate-900 dark:text-slate-100">
                    {h.from ? `${h.from.name} → ${h.to.name}` : `Created in ${h.to.name}`}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {h.by ? `${h.by.name} · ` : ""}
                    <time dateTime={h.at} title={fullDateTime(h.at)}>
                      {relativeTime(h.at)}
                    </time>
                  </p>
                </li>
              ))}
            </ol>
            {d.lostReason ? (
              <p className="border-t border-slate-200 px-5 py-3 text-sm dark:border-slate-800">
                <span className={sectionTitle}>Lost reason</span>
                <span className="mt-1 block break-words text-slate-800 dark:text-slate-200">
                  {d.lostReason}
                </span>
              </p>
            ) : null}
          </Card>
        </div>
      </div>

      <LostReasonDialog
        deal={pendingLost ? d : null}
        stage={pendingLost}
        onCancel={() => setPendingLost(null)}
        onConfirm={async (reason) => {
          const stage = pendingLost;
          setPendingLost(null);
          if (stage) await move(stage, reason);
        }}
      />
    </>
  );
}
