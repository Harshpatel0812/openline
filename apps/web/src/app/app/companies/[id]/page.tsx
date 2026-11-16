"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { CompanyDto } from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import { DealsCard } from "@/components/app/deals-card";
import { Alert, Card, CardHeader, LoadingBlock } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useResource } from "@/lib/use-resource";

export default function CompanyPage() {
  const { id } = useParams<{ id: string }>();
  // There is no single-company endpoint yet; the list is small and already loaded elsewhere.
  const { data, error, loading } = useResource<{ items: CompanyDto[] }>("/companies");
  const company = data?.items.find((c) => c.id === id);

  if (loading && !data) return <LoadingBlock label="Loading company" />;
  if (error || (data && !company)) {
    return (
      <div className="max-w-xl space-y-4">
        <Alert tone="error" title={error ? "Couldn't load this company" : "Company not found"}>
          {error
            ? errorMessage(error)
            : "It may have been removed, or it belongs to a different workspace."}
        </Alert>
        <Link
          href="/app/companies"
          className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-400"
        >
          ← Back to companies
        </Link>
      </div>
    );
  }
  if (!company) return null;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/app/companies" className="text-slate-600 hover:underline dark:text-slate-400">
          Companies
        </Link>
        <span aria-hidden="true" className="mx-2 text-slate-400">
          /
        </span>
        <span aria-current="page" className="text-slate-900 dark:text-slate-100">
          {company.name}
        </span>
      </nav>
      <PageHeader title={company.name} description={company.domain ?? undefined} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DealsCard
            path={`/companies/${company.id}/deals`}
            label={company.name}
            prefill={{
              name: `${company.name} — new deal`,
              company: { id: company.id, name: company.name },
            }}
          />
        </div>
        <Card className="h-fit">
          <CardHeader title="About" />
          <dl className="space-y-3 p-5 text-sm">
            <div>
              <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                Contacts
              </dt>
              <dd className="mt-0.5">{company.contactCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                Added
              </dt>
              <dd className="mt-0.5">{formatDate(company.createdAt)}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
