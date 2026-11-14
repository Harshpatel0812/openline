"use client";

import Link from "next/link";
import { PageHeader } from "@/components/app/app-shell";
import { SequenceEditor } from "@/components/app/sequence-editor";

export default function NewSequencePage() {
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/app/sequences" className="text-slate-600 hover:underline dark:text-slate-400">
          Sequences
        </Link>
        <span aria-hidden="true" className="mx-2 text-slate-400">
          /
        </span>
        <span aria-current="page" className="text-slate-900 dark:text-slate-100">
          New sequence
        </span>
      </nav>
      <PageHeader
        title="New sequence"
        description="It's saved as a draft. You can preview it and activate it when it's ready."
      />
      <div className="max-w-3xl">
        <SequenceEditor />
      </div>
    </>
  );
}
