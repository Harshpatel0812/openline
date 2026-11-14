"use client";

import { useState } from "react";
import type { EnrollmentDto } from "@openline/shared";
import { Badge, Button, Dialog, useToast } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ENROLLMENT_STATE_TONES, titleCase } from "@/lib/labels";

type Action = "pause" | "resume" | "stop" | "mark_replied";

const ACTION_LABELS: Record<Action, string> = {
  pause: "Pause",
  resume: "Resume",
  stop: "Stop",
  mark_replied: "Mark replied",
};

/** Actions that end the enrollment for good get a confirmation first. */
const CONFIRM: Partial<Record<Action, { title: string; body: string; cta: string }>> = {
  stop: {
    title: "Stop this enrollment?",
    body: "No more emails from this sequence will go to this contact. This can't be undone.",
    cta: "Stop sending",
  },
  mark_replied: {
    title: "Mark as replied?",
    body: "The contact counts as replied and gets no more emails from this sequence.",
    cta: "Mark replied",
  },
};

export function actionsFor(state: EnrollmentDto["state"]): Action[] {
  if (state === "active") return ["pause", "stop", "mark_replied"];
  if (state === "paused") return ["resume", "stop", "mark_replied"];
  if (state === "error") return ["stop", "mark_replied"];
  if (state === "completed") return ["mark_replied"];
  return [];
}

export function EnrollmentStateBadge({ state }: { state: EnrollmentDto["state"] }) {
  return <Badge tone={ENROLLMENT_STATE_TONES[state]}>{titleCase(state)}</Badge>;
}

/** Row actions for one enrollment (pause / resume / stop / mark replied). */
export function EnrollmentActions({
  enrollment,
  label,
  onUpdated,
}: {
  enrollment: EnrollmentDto;
  /** Who/what the row is about, for accessible button names. */
  label: string;
  onUpdated: (e: EnrollmentDto) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState<Action | null>(null);
  const actions = actionsFor(enrollment.state);
  if (actions.length === 0) return <span className="text-slate-500 dark:text-slate-400">—</span>;

  async function run(action: Action) {
    setBusy(action);
    try {
      const updated = await api<EnrollmentDto>(`/enrollments/${enrollment.id}/action`, {
        method: "POST",
        body: { action },
      });
      onUpdated(updated);
      setConfirming(null);
      toast(`${ACTION_LABELS[action]}: ${label}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  const confirm = confirming ? CONFIRM[confirming] : undefined;

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {actions.map((a) => (
          <Button
            key={a}
            size="sm"
            variant={a === "stop" ? "ghost" : "secondary"}
            className={a === "stop" ? "text-red-700 dark:text-red-400" : undefined}
            loading={busy === a && !CONFIRM[a]}
            disabled={busy !== null}
            aria-label={`${ACTION_LABELS[a]} — ${label}`}
            onClick={() => (CONFIRM[a] ? setConfirming(a) : void run(a))}
          >
            {ACTION_LABELS[a]}
          </Button>
        ))}
      </div>
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        size="sm"
        title={confirm?.title ?? ""}
        description={confirm ? `${label}: ${confirm.body}` : undefined}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirming(null)}
              disabled={busy !== null}
            >
              Cancel
            </Button>
            <Button
              variant={confirming === "stop" ? "danger" : "primary"}
              loading={busy !== null}
              onClick={() => confirming && void run(confirming)}
            >
              {confirm?.cta}
            </Button>
          </>
        }
      />
    </>
  );
}
