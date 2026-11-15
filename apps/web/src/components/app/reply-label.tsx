import type { LabelSource, ReplyLabel } from "@openline/shared";
import { Badge } from "@/components/ui";
import { REPLY_LABEL_TEXT, REPLY_LABEL_TONES } from "@/lib/inbox";

/** Label chip: the label's name in its colour, plus how it was decided. */
export function ReplyLabelChip({
  label,
  source,
  confidence,
}: {
  label: ReplyLabel | null;
  source: LabelSource | null;
  confidence: number | null;
}) {
  if (!label) {
    return <Badge tone="neutral">Classifying…</Badge>;
  }
  const extra =
    source === "rule"
      ? { text: "(rule)", sr: "labelled by a rule" }
      : source === "model" && confidence !== null
        ? {
            text: `${Math.round(confidence * 100)}%`,
            sr: `Scout is ${Math.round(confidence * 100)}% sure`,
          }
        : source === "model"
          ? { text: "Scout", sr: "labelled by Scout" }
          : null;
  return (
    <Badge tone={REPLY_LABEL_TONES[label]}>
      {REPLY_LABEL_TEXT[label]}
      {extra ? (
        <>
          <span aria-hidden="true" className="ml-1 font-normal">
            {extra.text}
          </span>
          <span className="sr-only">, {extra.sr}</span>
        </>
      ) : null}
    </Badge>
  );
}
