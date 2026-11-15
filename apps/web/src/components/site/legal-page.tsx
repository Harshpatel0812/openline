import { LEGAL } from "@/config/site";
import { Container } from "./blocks";
import { extractHeadings, Markdown } from "./markdown";

/** Layout for /privacy and /terms, with the draft notice shown until legal review is done. */
export function LegalPage({ title, source }: { title: string; source: string }) {
  const headings = extractHeadings(source);
  return (
    <Container className="py-10 sm:py-14">
      <p
        role="note"
        className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-100"
      >
        {LEGAL.draftNotice}
      </p>
      <div className="mt-8 grid gap-12 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <article className="max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
            Effective date: {LEGAL.effectiveDate}
          </p>
          <div className="mt-8">
            <Markdown source={source} />
          </div>
        </article>
        <nav aria-label="Sections" className="hidden lg:sticky lg:top-24 lg:block lg:self-start">
          <h2 className="text-sm font-semibold">Sections</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {headings.map((h) => (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  className="text-slate-600 hover:text-slate-950 hover:underline dark:text-slate-400 dark:hover:text-white"
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </Container>
  );
}
