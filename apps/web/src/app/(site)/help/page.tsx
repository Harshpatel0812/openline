import Link from "next/link";
import { Container, CtaBand, PageHero } from "@/components/site/blocks";
import { HelpSearch } from "@/components/site/help-search";
import { CONTACT_EMAILS } from "@/config/site";
import { HELP_ARTICLES, HELP_CATEGORIES, helpCategory } from "@/content/help";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Help centre",
  description:
    "Guides to getting started with Openline: importing contacts, connecting mailboxes, building sequences, replies, Scout, compliance and deliverability.",
  path: "/help",
});

export default function HelpPage() {
  const searchItems = HELP_ARTICLES.map((a) => ({
    slug: a.slug,
    title: a.title,
    summary: a.summary,
    category: helpCategory(a.category)?.title ?? "",
  }));

  return (
    <>
      <PageHero eyebrow="Help centre" title="How can we help?">
        <p>Short, practical guides that match how Openline works today.</p>
        <div className="mt-6 max-w-xl">
          <HelpSearch items={searchItems} />
        </div>
      </PageHero>

      <Container className="py-16 sm:py-20">
        <h2 className="sr-only">Browse by topic</h2>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {HELP_CATEGORIES.map((cat) => {
            const articles = HELP_ARTICLES.filter((a) => a.category === cat.id);
            return (
              <section
                key={cat.id}
                id={cat.id}
                aria-labelledby={`cat-${cat.id}`}
                className="scroll-mt-24 rounded-xl border border-slate-200 p-6 dark:border-slate-800"
              >
                <h3 id={`cat-${cat.id}`} className="text-lg font-semibold">
                  {cat.title}
                </h3>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{cat.description}</p>
                <ul className="mt-4 space-y-2">
                  {articles.map((a) => (
                    <li key={a.slug}>
                      <Link
                        href={`/help/${a.slug}`}
                        className="text-sm font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
                      >
                        {a.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <p className="mt-12 text-center text-slate-600 dark:text-slate-400">
          Can&apos;t find what you need? Email{" "}
          <a
            href={`mailto:${CONTACT_EMAILS.support}`}
            className="font-medium text-indigo-700 underline dark:text-indigo-300"
          >
            {CONTACT_EMAILS.support}
          </a>{" "}
          or{" "}
          <Link
            href="/contact"
            className="font-medium text-indigo-700 underline dark:text-indigo-300"
          >
            send us a message
          </Link>
          .
        </p>
      </Container>

      <CtaBand />
    </>
  );
}
