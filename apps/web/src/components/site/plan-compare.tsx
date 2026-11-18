"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "@/components/ui";
import { formatCount, formatPrice, PLANS, type Plan } from "@/content/pricing";
import { CheckIcon, SoonBadge } from "./blocks";

type Cell = string | "yes" | "soon";

interface Row {
  label: string;
  value: (p: Plan) => Cell;
}

const ROWS: { group: string; rows: Row[] }[] = [
  {
    group: "Price",
    rows: [
      { label: "Monthly billing", value: (p) => `${formatPrice(p.monthly)} / month` },
      { label: "Annual billing", value: (p) => `${formatPrice(p.annual)} / month` },
    ],
  },
  {
    group: "Limits",
    rows: [
      { label: "Users", value: (p) => formatCount(p.users) },
      { label: "Mailboxes", value: (p) => formatCount(p.mailboxes) },
      { label: "Contacts", value: (p) => formatCount(p.contacts) },
      { label: "Cold emails per day", value: (p) => formatCount(p.emailsPerDay) },
      { label: "Calling minutes", value: () => "soon" },
    ],
  },
  {
    group: "Included on every plan",
    rows: [
      { label: "CSV import, contacts and companies", value: () => "yes" },
      { label: "Sequences with stop rules", value: () => "yes" },
      { label: "Reply detection and inbox", value: () => "yes" },
      { label: "Scout drafts with approval", value: () => "yes" },
      { label: "Compliance checks before every send", value: () => "yes" },
      { label: "Suppression list and consent records", value: () => "yes" },
      { label: "Roles, invites and audit log", value: () => "yes" },
      { label: "Outlook / Microsoft 365", value: () => "soon" },
      { label: "Pipeline, deals and Reality Check", value: () => "yes" },
      { label: "CRM sync (HubSpot, Pipedrive)", value: () => "soon" },
    ],
  },
  {
    group: "Support",
    rows: [{ label: "Support", value: (p) => p.support }],
  },
];

function renderCell(cell: Cell): ReactNode {
  if (cell === "yes") {
    return (
      <>
        <CheckIcon className="inline" />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (cell === "soon") return <SoonBadge />;
  return cell;
}

function DesktopTable() {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Compare every Openline plan</caption>
        <thead>
          <tr className="border-b border-slate-300 dark:border-slate-700">
            <th scope="col" className="w-1/4 py-3 pr-4 font-semibold">
              <span className="sr-only">Feature</span>
            </th>
            {PLANS.map((p) => (
              <th key={p.id} scope="col" className="py-3 pr-4 text-base font-semibold">
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        {ROWS.map((group) => (
          <tbody key={group.group}>
            <tr>
              <th
                scope="colgroup"
                colSpan={PLANS.length + 1}
                className="bg-slate-50 py-2 pl-2 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-900 dark:text-slate-400"
              >
                {group.group}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.label} className="border-b border-slate-200 dark:border-slate-800">
                <th
                  scope="row"
                  className="py-3 pr-4 font-medium text-slate-800 dark:text-slate-200"
                >
                  {row.label}
                </th>
                {PLANS.map((p) => (
                  <td key={p.id} className="py-3 pr-4 text-slate-700 dark:text-slate-300">
                    {renderCell(row.value(p))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** Mobile: one plan at a time behind an ARIA tab list (arrow keys move between plans). */
function MobileTabs() {
  const [active, setActive] = useState(1);
  const baseId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = PLANS.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = active === last ? 0 : active + 1;
    if (e.key === "ArrowLeft") next = active === 0 ? last : active - 1;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="md:hidden">
      <div
        role="tablist"
        aria-label="Choose a plan to compare"
        className="grid grid-cols-4 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900"
        onKeyDown={onKeyDown}
      >
        {PLANS.map((p, i) => (
          <button
            key={p.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${p.id}`}
            aria-selected={active === i}
            aria-controls={`${baseId}-panel-${p.id}`}
            tabIndex={active === i ? 0 : -1}
            onClick={() => setActive(i)}
            className={cx(
              "rounded-md px-2 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600",
              active === i
                ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-800 dark:text-indigo-300"
                : "text-slate-700 dark:text-slate-300",
            )}
          >
            {p.name}
          </button>
        ))}
      </div>
      {PLANS.map((p, i) => (
        <div
          key={p.id}
          role="tabpanel"
          id={`${baseId}-panel-${p.id}`}
          aria-labelledby={`${baseId}-tab-${p.id}`}
          hidden={active !== i}
          tabIndex={0}
          className="mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
        >
          {ROWS.map((group) => (
            <div key={group.group} className="mt-4">
              <h3 className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
                {group.group}
              </h3>
              <dl className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
                {group.rows.map((row) => (
                  <div key={row.label} className="flex justify-between gap-4 py-2.5 text-sm">
                    <dt className="text-slate-700 dark:text-slate-300">{row.label}</dt>
                    <dd className="text-right font-medium">{renderCell(row.value(p))}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PlanCompare() {
  return (
    <>
      <DesktopTable />
      <MobileTabs />
    </>
  );
}
