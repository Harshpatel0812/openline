import Link from "next/link";
import { Container, CtaBand, PageHero } from "@/components/site/blocks";
import { readingMinutes } from "@/components/site/markdown";
import { BLOG_POSTS } from "@/content/blog";
import { formatPostDate } from "@/lib/dates";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Blog",
  description:
    "Practical writing on cold email deliverability, follow-ups and compliance for small B2B sales teams.",
  path: "/blog",
});

export default function BlogIndex() {
  const posts = [...BLOG_POSTS].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <PageHero eyebrow="Blog" title="Fewer, better, safer touches">
        <p>Practical notes on deliverability, follow-ups and the law, for teams that sell B2B.</p>
      </PageHero>
      <Container className="py-16 sm:py-20">
        <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <li key={post.slug}>
              <article className="relative flex h-full flex-col rounded-xl border border-slate-200 p-6 focus-within:ring-2 focus-within:ring-indigo-600 hover:border-indigo-300 dark:border-slate-800 dark:hover:border-indigo-700">
                <p className="text-xs font-semibold tracking-wide text-indigo-700 uppercase dark:text-indigo-300">
                  {post.category}
                </p>
                <h2 className="mt-2 text-lg font-semibold text-balance">
                  <Link
                    href={`/blog/${post.slug}`}
                    className="after:absolute after:inset-0 focus-visible:outline-none"
                  >
                    {post.title}
                  </Link>
                </h2>
                <p className="mt-2 flex-1 text-sm leading-6 text-slate-600 dark:text-slate-400">
                  {post.summary}
                </p>
                <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
                  <time dateTime={post.date}>{formatPostDate(post.date)}</time> ·{" "}
                  {readingMinutes(post.body)} min read
                </p>
              </article>
            </li>
          ))}
        </ul>
      </Container>
      <CtaBand />
    </>
  );
}
