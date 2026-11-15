import type { Metadata } from "next";
import { SITE, SITE_URL } from "@/config/site";

/** Absolute URL for a site path. */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path === "/" ? "" : path}`;
}

/** Title, description, canonical URL and Open Graph tags for a public page. */
export function pageMetadata({
  title,
  description,
  path,
  type = "website",
  noIndex = false,
}: {
  title: string;
  description: string;
  path: string;
  type?: "website" | "article";
  noIndex?: boolean;
}): Metadata {
  const url = absoluteUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${title} · ${SITE.name}`,
      description,
      url,
      siteName: SITE.name,
      type,
      locale: "en_US",
      images: [{ url: absoluteUrl("/screens/contacts.png"), width: 1440, height: 900 }],
    },
    twitter: { card: "summary_large_image", title: `${title} · ${SITE.name}`, description },
    ...(noIndex ? { robots: { index: false, follow: true } } : {}),
  };
}
