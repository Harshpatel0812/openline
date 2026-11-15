import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses, cx } from "@/components/ui";

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("mx-auto max-w-6xl px-4 sm:px-6", className)}>{children}</div>;
}

/** Page-top heading block with the page's only h1. */
export function PageHero({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="border-b border-slate-200 bg-gradient-to-b from-indigo-50/70 to-white dark:border-slate-800 dark:from-indigo-950/30 dark:to-slate-950">
      <Container className="py-14 sm:py-20">
        <div className="max-w-3xl">
          {eyebrow ? (
            <p className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">{eyebrow}</p>
          ) : null}
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance text-slate-950 sm:text-5xl dark:text-white">
            {title}
          </h1>
          {children ? (
            <div className="mt-5 text-lg leading-8 text-slate-600 dark:text-slate-300">
              {children}
            </div>
          ) : null}
          {actions ? <div className="mt-8 flex flex-col gap-3 sm:flex-row">{actions}</div> : null}
        </div>
      </Container>
    </section>
  );
}

export function SectionHeading({
  id,
  eyebrow,
  title,
  children,
  center = false,
}: {
  id?: string;
  eyebrow?: string;
  title: ReactNode;
  children?: ReactNode;
  center?: boolean;
}) {
  return (
    <div className={cx("max-w-2xl", center && "mx-auto text-center")}>
      {eyebrow ? (
        <p className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">{eyebrow}</p>
      ) : null}
      <h2
        id={id}
        className="mt-2 text-2xl font-semibold tracking-tight text-balance text-slate-950 sm:text-3xl dark:text-white"
      >
        {title}
      </h2>
      {children ? (
        <div className="mt-4 text-base leading-7 text-slate-600 dark:text-slate-300">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A real product screenshot in a light browser frame. */
export function Screenshot({
  src,
  alt,
  priority = false,
  className,
}: {
  src: string;
  alt: string;
  priority?: boolean;
  className?: string;
}) {
  return (
    <figure
      className={cx(
        "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/5 dark:border-slate-700 dark:bg-slate-900",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="flex h-7 items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-3 dark:border-slate-700 dark:bg-slate-800"
      >
        <span className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-600" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-600" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-600" />
      </div>
      <Image
        src={src}
        alt={alt}
        width={1440}
        height={900}
        priority={priority}
        sizes="(min-width: 1024px) 640px, 100vw"
        className="h-auto w-full"
      />
    </figure>
  );
}

export function SoonBadge({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
        className,
      )}
    >
      Coming soon
    </span>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={cx("h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400", className)}
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Closing call to action used at the bottom of most pages. */
export function CtaBand({
  title = "Send fewer, better, safer emails.",
  body = "Try every feature on the Team plan free for 14 days. No card needed.",
}: {
  title?: string;
  body?: string;
}) {
  return (
    <section aria-labelledby="cta-heading" className="bg-indigo-700 dark:bg-indigo-900">
      <Container className="py-16 text-center sm:py-20">
        <h2
          id="cta-heading"
          className="text-2xl font-semibold tracking-tight text-balance text-white sm:text-3xl"
        >
          {title}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-indigo-100">{body}</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/signup"
            className={cx(
              buttonClasses("secondary", "lg"),
              "border-white focus-visible:ring-white focus-visible:ring-offset-indigo-700",
            )}
          >
            Start free trial
          </Link>
          <Link
            href="/contact"
            className="inline-flex h-12 items-center justify-center rounded-lg px-6 text-base font-medium text-white ring-1 ring-white/60 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Talk to us
          </Link>
        </div>
      </Container>
    </section>
  );
}
