import type { MetadataRoute } from "next";
import { BLOG_POSTS } from "@/content/blog";
import { COMPARISONS, isVerified } from "@/content/compare";
import { HELP_ARTICLES } from "@/content/help";
import { absoluteUrl } from "@/lib/seo";

const STATIC_PAGES = [
  "/",
  "/features",
  "/pricing",
  "/help",
  "/blog",
  "/contact",
  "/security",
  "/privacy",
  "/terms",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...STATIC_PAGES.map((path) => ({ url: absoluteUrl(path) })),
    // Comparison pages are listed only once their competitor facts are verified.
    ...COMPARISONS.filter(isVerified).map((c) => ({
      url: absoluteUrl(`/compare/${c.slug}`),
      lastModified: c.checkedOn ?? undefined,
    })),
    ...HELP_ARTICLES.map((a) => ({ url: absoluteUrl(`/help/${a.slug}`), lastModified: a.updated })),
    ...BLOG_POSTS.map((p) => ({ url: absoluteUrl(`/blog/${p.slug}`), lastModified: p.date })),
  ];
}
