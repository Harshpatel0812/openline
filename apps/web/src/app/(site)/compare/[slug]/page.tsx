import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonClasses } from "@/components/ui";
import { CheckIcon, Container, CtaBand, PageHero } from "@/components/site/blocks";
import { getComparison, isVerified, type CompareRow } from "@/content/compare";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const c = getComparison(slug);
  if (!c) return {};
  return pageMetadata({
    title: `Openline vs ${c.competitor}`,
    description: `An honest comparison of Openline and ${c.competitor} for small B2B sales teams: when each one fits, and how they differ.`,
    path: `/compare/${c.slug}`,
    // Not indexed until competitor facts are verified against the vendor's own pages.
    noIndex: !isVerified(c),
  });
}

function formatDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function CompetitorCell({ row }: { row: CompareRow }) {
  if (!row.competitor) {
    return <span className="text-slate-500 italic dark:text-slate-400">Not yet verified</span>;
  }
  return (
    <>
      {row.competitor.value}{" "}
      <a
        href={row.competitor.source}
        rel="noopener noreferrer"
        target="_blank"
        className="text-xs text-indigo-700 underline dark:text-indigo-300"
      >
        source<span className="sr-only"> (opens in a new tab)</span>
      </a>
    </>
  );
}

export default async function ComparePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = getComparison(slug);
  if (!c) notFound();

  return (
    <>
      <PageHero
        eyebrow="Compare"
        title={`Openline vs ${c.competitor}`}
        actions={
          <>
            <Link href="/signup" className={buttonClasses("primary", "lg")}>
              Start free trial
            </Link>
            <Link href="/pricing" className={buttonClasses("secondary", "lg")}>
              See Openline pricing
            </Link>
          </>
        }
      >
        <p>{c.intro}</p>
      </PageHero>

      <section aria-labelledby="choose-heading">
        <Container className="py-16 sm:py-20">
          <h2 id="choose-heading" className="sr-only">
            Which one fits your team
          </h2>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-6 dark:border-indigo-900 dark:bg-indigo-950/30">
              <h3 className="text-lg font-semibold">Choose Openline if…</h3>
              <ul className="mt-4 space-y-3">
                {c.chooseOpenline.map((line) => (
                  <li key={line} className="flex gap-3 text-sm leading-6">
                    <CheckIcon />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-slate-200 p-6 dark:border-slate-800">
              <h3 className="text-lg font-semibold">Choose {c.competitor} if…</h3>
              <ul className="mt-4 space-y-3">
                {c.chooseThem.map((line) => (
                  <li key={line} className="flex gap-3 text-sm leading-6">
                    <CheckIcon className="text-slate-500 dark:text-slate-400" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Container>
      </section>

      <section aria-labelledby="table-heading" className="bg-slate-50 dark:bg-slate-900/40">
        <Container className="py-16 sm:py-20">
          <h2 id="table-heading" className="text-2xl font-semibold tracking-tight">
            Side by side
          </h2>

          <div className="mt-8 hidden overflow-x-auto md:block">
            <table className="w-full border-collapse bg-white text-left text-sm dark:bg-slate-900">
              <caption className="sr-only">Openline compared with {c.competitor}</caption>
              <thead>
                <tr className="border-b border-slate-300 dark:border-slate-700">
                  <th scope="col" className="w-1/4 px-4 py-3 font-semibold">
                    <span className="sr-only">Feature</span>
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Openline
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    {c.competitor}
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.rows.map((row) => (
                  <tr key={row.label} className="border-b border-slate-200 dark:border-slate-800">
                    <th scope="row" className="px-4 py-3 align-top font-medium">
                      {row.label}
                    </th>
                    <td className="px-4 py-3 align-top text-slate-700 dark:text-slate-300">
                      {row.openline}
                    </td>
                    <td className="px-4 py-3 align-top text-slate-700 dark:text-slate-300">
                      <CompetitorCell row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="mt-8 space-y-3 md:hidden">
            {c.rows.map((row) => (
              <li
                key={row.label}
                className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
              >
                <h3 className="font-semibold">{row.label}</h3>
                <dl className="mt-2 space-y-2 text-sm">
                  <div>
                    <dt className="text-xs font-semibold text-indigo-700 uppercase dark:text-indigo-300">
                      Openline
                    </dt>
                    <dd>{row.openline}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold text-slate-600 uppercase dark:text-slate-400">
                      {c.competitor}
                    </dt>
                    <dd>
                      <CompetitorCell row={row} />
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>

          <aside
            aria-label="About these details"
            className="mt-8 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          >
            <p>
              {c.checkedOn
                ? `Competitor details checked on ${formatDate(c.checkedOn)}. Prices and features change — check the vendor's own pages before you decide.`
                : `Competitor details not yet verified (page reviewed ${formatDate("2026-11-15")}). We only publish ${c.competitor}'s details once we've checked them against ${c.competitor}'s own pages, and prices change — so please check their current plans directly.`}
            </p>
            <ul className="mt-2 list-disc pl-5">
              {c.sources.map((s) => (
                <li key={s.url}>
                  <a
                    href={s.url}
                    rel="noopener noreferrer"
                    target="_blank"
                    className="font-medium underline underline-offset-2"
                  >
                    {s.label}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Spotted something out of date?{" "}
              <Link href="/contact" className="font-medium underline underline-offset-2">
                Tell us
              </Link>{" "}
              and we&apos;ll fix it.
            </p>
          </aside>
        </Container>
      </section>

      <CtaBand title={`Thinking about ${c.competitor}? Try Openline side by side first.`} />
    </>
  );
}
