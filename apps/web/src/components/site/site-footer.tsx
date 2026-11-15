import Link from "next/link";
import { Logo } from "@/components/app/logo";
import { CONTACT_EMAILS, SITE } from "@/config/site";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/features" },
      { label: "Pricing", href: "/pricing" },
      { label: "Security", href: "/security" },
      { label: "Start free trial", href: "/signup" },
    ],
  },
  {
    title: "Compare",
    links: [
      { label: "Openline vs Apollo", href: "/compare/openline-vs-apollo" },
      { label: "Openline vs Outreach", href: "/compare/openline-vs-outreach" },
      { label: "Openline vs HubSpot", href: "/compare/openline-vs-hubspot" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Help centre", href: "/help" },
      { label: "Blog", href: "/blog" },
      { label: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
      { label: "Trust centre", href: "/security" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div className="max-w-xs">
            <Logo />
            <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-400">
              {SITE.tagline}
            </p>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              <a
                className="underline underline-offset-2 hover:text-slate-900 dark:hover:text-white"
                href={`mailto:${CONTACT_EMAILS.hello}`}
              >
                {CONTACT_EMAILS.hello}
              </a>
            </p>
          </div>
          {columns.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{col.title}</h2>
              <ul className="mt-3 space-y-2">
                {col.links.map((link) => (
                  <li key={link.href + link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-slate-600 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-white"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-slate-200 pt-6 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800 dark:text-slate-400">
          <p>© {new Date().getFullYear()} Openline. Prices in USD.</p>
          <Link
            href="/privacy#cookies"
            className="hover:text-slate-900 hover:underline dark:hover:text-white"
          >
            We only use essential cookies
          </Link>
        </div>
      </div>
    </footer>
  );
}
