"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  FirstTouchDraftInputSchema,
  type AiActionDto,
  type ContactListDto,
  type EnrollmentDto,
  type ScoutSettingsDto,
} from "@openline/shared";
import { Alert, Button, cx, Dialog, Field, Input, Spinner, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { contactName } from "@/lib/format";
import { scoutErrorMessage, type ScoutProblem } from "@/lib/scout";
import { useDebounced, useResource } from "@/lib/use-resource";
import { ScoutProblemAlert, ScoutReview, type ApprovedDraft } from "./scout-review";

interface SampleContact {
  id: string;
  name: string;
  detail: string;
}

/** Why Scout can't be used, from the workspace settings (null = looks available). */
export function scoutUnavailableReason(s: ScoutSettingsDto | undefined): string | null {
  if (!s) return null;
  if (!s.providerConfigured) {
    return "Scout isn't set up on this server yet (no AI model is configured).";
  }
  if (!s.enabled)
    return "Scout is turned off for this workspace. An owner or admin can turn it on.";
  if (s.usage.creditsRemaining <= 0) {
    return "This month's Scout credits are used up.";
  }
  return null;
}

/**
 * "Draft with Scout" for one sequence step: purpose + a sample contact → Scout proposal → review.
 * Approving returns the text to the step form; the user still saves the sequence.
 */
export function ScoutFirstTouchDialog({
  open,
  onClose,
  sequenceId,
  stepPosition,
  stepHasContent,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  sequenceId?: string;
  stepPosition: number;
  stepHasContent: boolean;
  onApply: (draft: { subject: string; body: string }) => void;
}) {
  const [purpose, setPurpose] = useState("");
  const [contact, setContact] = useState<SampleContact | null>(null);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [drafting, setDrafting] = useState(false);
  const [problem, setProblem] = useState<ScoutProblem | null>(null);
  const [action, setAction] = useState<AiActionDto | null>(null);
  const [status, setStatus] = useState("");
  const formId = useId();
  const listLabelId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const settings = useResource<ScoutSettingsDto>(open ? "/workspace/scout" : null);
  const enrolled = useResource<{ items: EnrollmentDto[]; nextCursor: string | null }>(
    open && sequenceId ? `/sequences/${sequenceId}/enrollments` : null,
    { limit: 6 },
  );
  const found = useResource<ContactListDto>(open && q ? "/contacts" : null, { q, limit: 6 });
  const recent = useResource<ContactListDto>(open && !q ? "/contacts" : null, { limit: 6 });
  // In a sequence, offer its enrolled contacts first; fall back to recent contacts.
  const useEnrolled =
    Boolean(sequenceId) && (enrolled.loading || (enrolled.data?.items.length ?? 0) > 0);

  useEffect(() => {
    if (open) {
      setPurpose("");
      setContact(null);
      setSearch("");
      setErrors({});
      setProblem(null);
      setAction(null);
      setStatus("");
    }
  }, [open]);

  const options: SampleContact[] = (() => {
    if (q) {
      return (found.data?.items ?? []).map((c) => ({
        id: c.id,
        name: contactName(c),
        detail: [c.title, c.company?.name].filter(Boolean).join(" · ") || c.email,
      }));
    }
    if (useEnrolled) {
      const seen = new Set<string>();
      return (enrolled.data?.items ?? [])
        .filter((e) => (seen.has(e.contact.id) ? false : (seen.add(e.contact.id), true)))
        .map((e) => ({
          id: e.contact.id,
          name: contactName(e.contact),
          detail: e.contact.email,
        }));
    }
    return (recent.data?.items ?? []).map((c) => ({
      id: c.id,
      name: contactName(c),
      detail: [c.title, c.company?.name].filter(Boolean).join(" · ") || c.email,
    }));
  })();
  const listLoading = q ? found.loading : useEnrolled ? enrolled.loading : recent.loading;
  const unavailable = scoutUnavailableReason(settings.data);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // This dialog is rendered from inside the sequence form; don't let the submit reach it.
    e.stopPropagation();
    setProblem(null);
    const parsed = FirstTouchDraftInputSchema.safeParse({
      contactId: contact?.id ?? "",
      purpose,
      sequenceId,
      stepPosition: sequenceId ? stepPosition : undefined,
    });
    if (!parsed.success) {
      const fe: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key === "contactId") fe.contactId = "Pick a sample contact";
        else if (key === "purpose")
          fe.purpose = "Say in a few words what this email is for (3–500 characters)";
      }
      setErrors(fe);
      if (fe.contactId && !fe.purpose) searchRef.current?.focus();
      return;
    }
    setErrors({});
    setDrafting(true);
    setStatus("Scout is drafting…");
    try {
      const result = await api<AiActionDto>("/scout/drafts/first-touch", {
        method: "POST",
        body: parsed.data,
      });
      setAction(result);
      setStatus("Scout's draft is ready for review.");
    } catch (err) {
      setProblem(scoutErrorMessage(err));
      setStatus("Scout couldn't draft this email.");
    } finally {
      setDrafting(false);
    }
  }

  function approved(d: ApprovedDraft) {
    onApply({ subject: d.subject ?? "", body: d.body });
  }

  // Portalled out of the sequence editor's <form> (forms can't nest).
  if (!mounted) return null;
  return createPortal(
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Draft step ${stepPosition} with Scout`}
      description={
        action
          ? undefined
          : "Scout writes a first draft for one sample contact, citing where each fact came from. You review and edit it before it goes into the step."
      }
      footer={
        action ? undefined : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={drafting}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={drafting}>
              {drafting ? "Drafting…" : "Draft with Scout"}
            </Button>
          </>
        )
      }
    >
      <p className="sr-only" aria-live="polite" role="status">
        {status}
      </p>
      {action ? (
        <div className="space-y-3">
          {stepHasContent ? (
            <Alert tone="warning">
              Approving replaces step {stepPosition}&apos;s current subject and body.
            </Alert>
          ) : null}
          <ScoutReview
            action={action}
            approveLabel={`use in step ${stepPosition}`}
            applyHint="Puts the text into the step. Nothing is sent — save the sequence to keep it."
            onApproved={approved}
            onRejected={() => {
              setAction(null);
              setStatus("Draft rejected. You can ask for another one.");
            }}
            onDiscard={() => setAction(null)}
          />
        </div>
      ) : (
        <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5">
          {unavailable ? <Alert tone="warning">{unavailable}</Alert> : null}
          {problem ? <ScoutProblemAlert problem={problem} /> : null}
          <Field
            label="What is this email for?"
            hint="One line, e.g. “Introduce our audit tool to operations leaders and ask for a 15-minute call”."
            error={errors.purpose}
            required
          >
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                maxLength={500}
                value={purpose}
                disabled={drafting}
                onChange={(e) => setPurpose(e.target.value)}
              />
            )}
          </Field>

          <fieldset aria-describedby={errors.contactId ? `${listLabelId}-err` : undefined}>
            <legend
              id={listLabelId}
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Sample contact
              <span aria-hidden="true" className="ml-0.5 text-red-600 dark:text-red-400">
                *
              </span>
            </legend>
            <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
              Scout personalises for this person; generic parts use variables like{" "}
              <code className="font-mono">{"{{firstName}}"}</code> so the step works for everyone.
            </p>
            <div className="mt-3">
              <label htmlFor={`${formId}-search`} className="sr-only">
                Search contacts
              </label>
              <Input
                id={`${formId}-search`}
                ref={searchRef}
                type="search"
                placeholder="Search contacts by name, email or company"
                value={search}
                disabled={drafting}
                onChange={(e) => setSearch(e.target.value)}
                autoComplete="off"
              />
            </div>
            <p className="mt-2 text-xs font-medium text-slate-600 dark:text-slate-400">
              {q ? "Search results" : useEnrolled ? "Contacts in this sequence" : "Recent contacts"}
            </p>
            <div className="mt-1 min-h-16">
              {listLoading ? (
                <div className="flex items-center gap-2 py-3 text-sm text-slate-600 dark:text-slate-400">
                  <Spinner size="sm" label="" /> Loading contacts…
                </div>
              ) : options.length === 0 ? (
                <p className="py-3 text-sm text-slate-600 dark:text-slate-400">
                  {q
                    ? "No contacts match. Try another name or email."
                    : "No contacts yet. Add or import contacts first."}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {options.map((o) => {
                    const checked = contact?.id === o.id;
                    return (
                      <li key={o.id}>
                        <label
                          className={cx(
                            "flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 text-sm focus-within:ring-2 focus-within:ring-indigo-600",
                            checked
                              ? "border-indigo-600 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950"
                              : "border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
                          )}
                        >
                          <input
                            type="radio"
                            name={`${formId}-contact`}
                            checked={checked}
                            disabled={drafting}
                            onChange={() => setContact(o)}
                            className="accent-indigo-600"
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-slate-900 dark:text-slate-100">
                              {o.name}
                            </span>
                            <span className="block truncate text-xs text-slate-600 dark:text-slate-400">
                              {o.detail}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {contact && !options.some((o) => o.id === contact.id) ? (
              <p className="mt-2 text-xs text-slate-700 dark:text-slate-300">
                Selected: <strong>{contact.name}</strong>
              </p>
            ) : null}
            {errors.contactId ? (
              <p
                id={`${listLabelId}-err`}
                className="mt-1 text-xs font-medium text-red-700 dark:text-red-400"
              >
                {errors.contactId}
              </p>
            ) : null}
          </fieldset>
          {drafting ? (
            <p className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <Spinner size="sm" label="" />
              Scout is drafting — this usually takes a few seconds.
            </p>
          ) : null}
        </form>
      )}
    </Dialog>,
    document.body,
  );
}
