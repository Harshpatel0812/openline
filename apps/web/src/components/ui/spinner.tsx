import { cx } from "./cx";

export function Spinner({
  size = "md",
  label = "Loading",
  className,
}: {
  size?: "sm" | "md" | "lg";
  /** Accessible label; pass "" when the spinner is decorative (e.g. inside a busy button). */
  label?: string;
  className?: string;
}) {
  const dims = { sm: "h-4 w-4", md: "h-5 w-5", lg: "h-8 w-8" }[size];
  return (
    <span
      role={label ? "status" : undefined}
      aria-hidden={label ? undefined : true}
      className="inline-flex items-center"
    >
      <svg
        className={cx("animate-spin text-current motion-reduce:animate-none", dims, className)}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

/** Centered spinner for page/section loading states. */
export function LoadingBlock({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-slate-500 dark:text-slate-400">
      <Spinner label={label} />
      <span aria-hidden="true" className="text-sm">
        {label}…
      </span>
    </div>
  );
}
