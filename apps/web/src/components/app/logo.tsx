import Link from "next/link";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-md text-base font-semibold tracking-tight text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:text-white"
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-sm font-bold text-white"
      >
        O
      </span>
      Openline
    </Link>
  );
}

/** Centered card layout for sign-in, sign-up and invite pages. */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-10 sm:py-16">
      <Logo />
      <main
        id="main"
        className="mt-8 w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-xs sm:p-8 dark:border-slate-800 dark:bg-slate-900"
      >
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>
        ) : null}
        <div className="mt-6">{children}</div>
      </main>
    </div>
  );
}
