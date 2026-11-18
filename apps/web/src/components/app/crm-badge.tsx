import { Badge } from "@/components/ui";
import { crmBadge, type CrmRecordLinkDto } from "@/lib/crm";

/**
 * "Synced with HubSpot · 4 min ago" (linking to the CRM record), "Not synced: <reason>",
 * "Deleted in HubSpot" or "Sync paused". Renders nothing for records with no CRM state.
 */
export function CrmBadge({
  crm,
  label,
}: {
  crm: CrmRecordLinkDto | null | undefined;
  /** Name of the record, for the link's accessible name. */
  label?: string;
}) {
  if (!crm) return null;
  const view = crmBadge(crm);
  const badge = (
    <Badge tone={view.tone} className="gap-1">
      {view.text}
      {view.href ? (
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3 w-3">
          <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
          <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
        </svg>
      ) : null}
    </Badge>
  );
  if (!view.href) return <span data-testid="crm-badge">{badge}</span>;
  return (
    <a
      href={view.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="crm-badge"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex rounded-md hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none"
    >
      {badge}
      <span className="sr-only">
        {" "}
        (open {label ? `${label} ` : ""}in the CRM, opens in a new tab)
      </span>
    </a>
  );
}
