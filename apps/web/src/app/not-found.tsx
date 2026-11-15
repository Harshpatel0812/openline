import Link from "next/link";
import { buttonClasses } from "@/components/ui";
import { Container } from "@/components/site/blocks";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";

export const metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-slate-950">
      <SiteHeader />
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        <Container className="py-24 text-center sm:py-32">
          <p className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">404</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            We couldn&apos;t find that page
          </h1>
          <p className="mx-auto mt-4 max-w-md text-slate-600 dark:text-slate-400">
            The link may be old, or the page may have moved. These might help:
          </p>
          <nav
            aria-label="Helpful links"
            className="mt-8 flex flex-col justify-center gap-3 sm:flex-row"
          >
            <Link href="/" className={buttonClasses("primary", "lg")}>
              Back to the home page
            </Link>
            <Link href="/help" className={buttonClasses("secondary", "lg")}>
              Help centre
            </Link>
            <Link href="/contact" className={buttonClasses("ghost", "lg")}>
              Contact us
            </Link>
          </nav>
        </Container>
      </main>
      <SiteFooter />
    </div>
  );
}
