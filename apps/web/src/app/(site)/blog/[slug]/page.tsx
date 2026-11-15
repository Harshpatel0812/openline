import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container, CtaBand } from "@/components/site/blocks";
import { Markdown, readingMinutes } from "@/components/site/markdown";
import { BLOG_POSTS, getBlogPost } from "@/content/blog";
import { formatPostDate } from "@/lib/dates";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) return {};
  return pageMetadata({
    title: post.title,
    description: post.summary,
    path: `/blog/${post.slug}`,
    type: "article",
  });
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) notFound();
  const others = BLOG_POSTS.filter((p) => p.slug !== post.slug);

  return (
    <>
      <Container className="py-10 sm:py-14">
        <article className="mx-auto max-w-3xl">
          <p className="text-sm">
            <Link href="/blog" className="text-slate-600 hover:underline dark:text-slate-400">
              ← All posts
            </Link>
          </p>
          <p className="mt-6 text-xs font-semibold tracking-wide text-indigo-700 uppercase dark:text-indigo-300">
            {post.category}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {post.title}
          </h1>
          <p className="mt-4 text-lg text-slate-600 dark:text-slate-400">{post.summary}</p>
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            The Openline team · <time dateTime={post.date}>{formatPostDate(post.date)}</time> ·{" "}
            {readingMinutes(post.body)} min read
          </p>
          <div className="mt-10">
            <Markdown source={post.body} />
          </div>
        </article>

        <nav
          aria-label="More posts"
          className="mx-auto mt-16 max-w-3xl border-t border-slate-200 pt-8 dark:border-slate-800"
        >
          <h2 className="text-lg font-semibold">Keep reading</h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2">
            {others.map((p) => (
              <li key={p.slug}>
                <Link
                  href={`/blog/${p.slug}`}
                  className="block rounded-lg border border-slate-200 p-4 hover:border-indigo-300 dark:border-slate-800"
                >
                  <span className="block font-medium">{p.title}</span>
                  <span className="mt-1 block text-sm text-slate-600 dark:text-slate-400">
                    {readingMinutes(p.body)} min read
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Container>
      <CtaBand />
    </>
  );
}
