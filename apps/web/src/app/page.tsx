import Link from "next/link";
import { Logo } from "@/components/app/logo";
import { buttonClasses } from "@/components/ui";

const valueProps = [
  {
    title: "Out of spam",
    body: "Deliverability guardrails are on by default: daily caps per mailbox, human-like send spacing and automatic pauses when bounces climb.",
  },
  {
    title: "Out of trouble",
    body: "Compliance checks run before every send — suppression lists, consent basis and local send windows — so nobody gets an email they shouldn't.",
  },
  {
    title: "True to your word",
    body: "Promise Keeper AI spots the commitments you make in replies (“I'll send the deck Friday”) and makes sure you follow through.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-white dark:bg-slate-950">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <nav aria-label="Account" className="flex items-center gap-2">
          <Link href="/login" className={buttonClasses("ghost", "sm")}>
            Sign in
          </Link>
          <Link href="/signup" className={buttonClasses("primary", "sm")}>
            Start free trial
          </Link>
        </nav>
      </header>

      <main id="main">
        <section className="mx-auto max-w-3xl px-4 pt-16 pb-20 text-center sm:px-6 sm:pt-24">
          <p className="text-sm font-medium text-indigo-700 dark:text-indigo-400">
            Outreach CRM for small B2B sales teams
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl dark:text-white">
            Openline
          </h1>
          <p className="mt-5 text-lg text-slate-600 sm:text-xl dark:text-slate-300">
            The outreach CRM that keeps you out of spam, out of trouble, and true to your word.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/signup" className={buttonClasses("primary", "lg")}>
              Start free trial
            </Link>
            <Link href="/login" className={buttonClasses("secondary", "lg")}>
              Sign in
            </Link>
          </div>
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            Free trial · Flat, transparent pricing · Compliance built in
          </p>
        </section>

        <section
          aria-labelledby="why-heading"
          className="border-t border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40"
        >
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="why-heading" className="sr-only">
              Why Openline
            </h2>
            <ul className="grid gap-6 md:grid-cols-3">
              {valueProps.map((v) => (
                <li
                  key={v.title}
                  className="rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
                >
                  <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                    {v.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
                    {v.body}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="mx-auto max-w-6xl px-4 py-8 text-sm text-slate-500 sm:px-6 dark:text-slate-400">
        © {new Date().getFullYear()} Openline
      </footer>
    </div>
  );
}
