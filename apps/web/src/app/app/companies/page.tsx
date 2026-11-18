"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { CompanyDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { CrmBadge } from "@/components/app/crm-badge";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingBlock,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { crmOf } from "@/lib/crm";
import { formatDate } from "@/lib/format";
import { useDebounced, useResource } from "@/lib/use-resource";

export default function CompaniesPage() {
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const { data, error, loading, reload } = useResource<{ items: CompanyDto[] }>("/companies", {
    q: q || undefined,
  });
  const searchId = useId();
  const items = data?.items;

  return (
    <>
      <PageHeader
        title="Companies"
        description="Created automatically from your contacts' email domains (free-mail addresses are skipped)."
      />
      <Card>
        <div className="border-b border-slate-200 p-4 dark:border-slate-800">
          <label htmlFor={searchId} className="sr-only">
            Search companies
          </label>
          <Input
            id={searchId}
            type="search"
            placeholder="Search by name or domain"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
        </div>
        {loading && !items ? (
          <LoadingBlock label="Loading companies" />
        ) : error ? (
          <div className="p-4">
            <Alert tone="error" title="Couldn't load companies">
              {errorMessage(error)}
            </Alert>
            <Button variant="secondary" size="sm" className="mt-3" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : !items || items.length === 0 ? (
          q ? (
            <EmptyState title="No matches" description={`No companies match “${q}”.`} />
          ) : (
            <EmptyState
              title="No companies yet"
              description="Companies appear here as you add or import contacts with work email addresses."
            />
          )
        ) : (
          <div aria-busy={loading} className={loading ? "opacity-60" : undefined}>
            <Table caption="Companies">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Domain</Th>
                  <Th className="text-right">Contacts</Th>
                  <Th>Added</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <Td className="font-medium">
                      <Link
                        href={`/app/companies/${c.id}`}
                        className="text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:outline-none dark:text-indigo-300"
                      >
                        {c.name}
                      </Link>
                      {crmOf(c) ? (
                        <div className="mt-1">
                          <CrmBadge crm={crmOf(c)} label={c.name} />
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-slate-600 dark:text-slate-400">{c.domain ?? "—"}</Td>
                    <Td className="text-right tabular-nums">{c.contactCount.toLocaleString()}</Td>
                    <Td className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                      {formatDate(c.createdAt)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="p-4 text-sm text-slate-600 dark:text-slate-400" aria-live="polite">
              {items.length.toLocaleString()} compan{items.length === 1 ? "y" : "ies"}
            </p>
          </div>
        )}
      </Card>
    </>
  );
}
