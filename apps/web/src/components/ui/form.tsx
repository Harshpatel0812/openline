"use client";

import {
  useId,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { cx } from "./cx";

const control =
  "block w-full rounded-lg border bg-white px-3 text-sm text-slate-900 shadow-xs placeholder:text-slate-500 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:border-indigo-600 " +
  "disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 " +
  "dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-400 dark:focus-visible:ring-indigo-400 dark:disabled:bg-slate-800 " +
  "aria-[invalid=true]:border-red-600 dark:aria-[invalid=true]:border-red-400";

const borderOk = "border-slate-300 dark:border-slate-700";

export function Label({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cx("block text-sm font-medium text-slate-800 dark:text-slate-200", className)}
      {...rest}
    />
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(control, borderOk, "h-10", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(control, borderOk, "h-10 pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, id, className, ...rest }: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = description ? `${inputId}-desc` : undefined;
  return (
    <div className={cx("flex items-start gap-3", className)}>
      <input
        id={inputId}
        type="checkbox"
        aria-describedby={descId}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-400 accent-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 dark:accent-indigo-400"
        {...rest}
      />
      <div className="text-sm">
        <label htmlFor={inputId} className="text-slate-800 dark:text-slate-200">
          {label}
        </label>
        {description ? (
          <p id={descId} className="text-slate-600 dark:text-slate-400">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/** Label + control + hint + error, with aria wiring. Children receive the control props. */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("space-y-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-red-600 dark:text-red-400">
            *
          </span>
        ) : null}
      </Label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-xs text-slate-600 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
