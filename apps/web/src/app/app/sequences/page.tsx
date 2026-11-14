"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SequenceDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import {
  Alert,
  Badge,
  buttonClasses,
  Card,
  Checkbox,
  EmptyState,
  LoadingBlock,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { SEQUENCE_STATUS_TONES, titleCase } from "@/lib/labels";
import { useResource } from "@/lib/use-resource";

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium text-slate-900 dark:text-white">{value.toLocaleString()}</span>{" "}
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
    </span>
  );
}

export default function SequencesPage() {
  const router = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, loading, reload } = useResource<SequenceDto[]>("/sequences", {
    includeArchived: showArchived ? "true" : undefined,
  });

  const newButton = (
    <Link href="/app/sequences/new" className={buttonClasses("primary")}>
      New sequence
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Sequences"
        description="Multi-step email outreach that respects business hours, daily limits and opt-outs."
        actions={newButton}
      />
      <Card>
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <Checkbox
            label="Show archived"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
        </div>
        {loading && !data ? (
          <LoadingBlock label="Loading sequences" />
        ) : error ? (
          <div className="p-4">
            <Alert tone="error" title="Couldn't load sequences">
              {errorMessage(error)}{" "}
              <button type="button" className="font-medium underline" onClick={reload}>
                Try again
              </button>
            </Alert>
          </div>
        ) : !data || data.length === 0 ? (
          <EmptyState
            title={showArchived ? "No sequences" : "No sequences yet"}
            description="Write a few short, personal emails once. Openline sends them at the right time and stops the moment someone replies or opts out."
            action={newButton}
          />
        ) : (
          <div aria-busy={loading} className={loading ? "opacity-60" : undefined}>
            <Table caption="Sequences">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th>Steps</Th>
                  <Th>Activity</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => router.push(`/app/sequences/${s.id}`)}
                    className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  >
                    <Td className="font-medium">
                      <Link
                        href={`/app/sequences/${s.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded text-slate-900 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-white"
                      >
                        {s.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone={SEQUENCE_STATUS_TONES[s.status]}>{titleCase(s.status)}</Badge>
                    </Td>
                    <Td>{s.steps.length}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                        <Stat value={s.stats.active} label="active" />
                        <Stat value={s.stats.sent} label="sent" />
                        <Stat value={s.stats.replied} label="replied" />
                        <Stat value={s.stats.unsubscribed} label="unsubscribed" />
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                      {formatDate(s.createdAt)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
