import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container } from "@/components/site/blocks";
import { extractHeadings, Markdown } from "@/components/site/markdown";
import { CONTACT_EMAILS } from "@/config/site";
import { getHelpArticle, HELP_ARTICLES, helpCategory } from "@/content/help";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) return {};
  return pageMetadata({
    title: article.title,
    description: article.summary,
    path: `/help/${article.slug}`,
    type: "article",
  });
}

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) notFound();
  const category = helpCategory(article.category);
  const headings = extractHeadings(article.body);
  const related = HELP_ARTICLES.filter((a) => a.slug !== article.slug).slice(0, 4);

  return (
    <Container className="py-10 sm:py-14">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-600 dark:text-slate-400">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link href="/help" className="hover:underline">
              Help centre
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href={`/help#${article.category}`} className="hover:underline">
              {category?.title}
            </Link>
          </li>
        </ol>
      </nav>

      <div className="mt-6 grid gap-12 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <article>
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {article.title}
          </h1>
          <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">{article.summary}</p>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Last checked against the product on{" "}
            <time dateTime={article.updated}>
              {new Date(`${article.updated}T12:00:00Z`).toLocaleDateString("en-US", {
                dateStyle: "long",
                timeZone: "UTC",
              })}
            </time>
          </p>
          <div className="mt-8 max-w-3xl">
            <Markdown source={article.body} />
          </div>
          <p className="mt-12 rounded-lg bg-slate-50 p-4 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-300">
            Still stuck? Email{" "}
            <a
              href={`mailto:${CONTACT_EMAILS.support}`}
              className="font-medium text-indigo-700 underline dark:text-indigo-300"
            >
              {CONTACT_EMAILS.support}
            </a>{" "}
            and a person will answer.
          </p>
        </article>

        <aside className="space-y-8 lg:sticky lg:top-24 lg:self-start">
          {headings.length > 1 ? (
            <nav aria-label="On this page">
              <h2 className="text-sm font-semibold">On this page</h2>
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
          ) : null}
          <nav aria-label="More help articles">
            <h2 className="text-sm font-semibold">More articles</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {related.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/help/${a.slug}`}
                    className="text-indigo-700 hover:underline dark:text-indigo-300"
                  >
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      </div>
    </Container>
  );
}
