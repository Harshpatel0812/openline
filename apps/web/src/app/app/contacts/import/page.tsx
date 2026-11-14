"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import {
  IMPORT_MAX_BYTES,
  type ImportField,
  type ImportPreviewDto,
  type ImportResultDto,
} from "@openline/shared";
import { PageHeader } from "@/components/app/app-shell";
import {
  Alert,
  Badge,
  Button,
  buttonClasses,
  Card,
  CardHeader,
  Checkbox,
  Label,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { cx } from "@/components/ui";

const FIELD_LABELS: Record<ImportField, string> = {
  email: "Email",
  firstName: "First name",
  lastName: "Last name",
  title: "Job title",
  phone: "Phone",
  timeZone: "Time zone",
  country: "Country",
  companyDomain: "Company domain",
  companyName: "Company name",
};

const DELIMITER_LABELS: Record<ImportPreviewDto["delimiter"], string> = {
  ",": "comma",
  ";": "semicolon",
  "\t": "tab",
};

type Step = "upload" | "preview" | "done";

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("read_failed"));
    reader.readAsText(file);
  });
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger" | "warning";
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
      </dt>
      <dd
        className={cx(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "danger" && value > 0 && "text-red-700 dark:text-red-400",
          tone === "warning" && value > 0 && "text-amber-700 dark:text-amber-400",
        )}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "upload", label: "Upload" },
    { key: "preview", label: "Review" },
    { key: "done", label: "Done" },
  ];
  const current = steps.findIndex((s) => s.key === step);
  return (
    <ol className="mb-6 flex items-center gap-2 text-sm" aria-label="Import progress">
      {steps.map((s, i) => (
        <li
          key={s.key}
          className="flex items-center gap-2"
          aria-current={i === current ? "step" : undefined}
        >
          <span
            className={cx(
              "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
              i < current && "bg-indigo-600 text-white",
              i === current &&
                "bg-indigo-100 text-indigo-800 ring-1 ring-indigo-600 dark:bg-indigo-950 dark:text-indigo-200",
              i > current && "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
            )}
            aria-hidden="true"
          >
            {i + 1}
          </span>
          <span className={i === current ? "font-medium" : "text-slate-600 dark:text-slate-400"}>
            {s.label}
            {i < current ? <span className="sr-only"> (completed)</span> : null}
          </span>
          {i < steps.length - 1 ? (
            <span aria-hidden="true" className="mx-1 h-px w-8 bg-slate-300 dark:bg-slate-700" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export default function ImportPage() {
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [result, setResult] = useState<ImportResultDto | null>(null);
  const [duplicates, setDuplicates] = useState<"skip" | "update">("skip");
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const fileHintId = useId();

  async function onUpload(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a .csv file to upload.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("That doesn't look like a CSV file. Export your list as .csv and try again.");
      return;
    }
    if (file.size > IMPORT_MAX_BYTES) {
      setError(
        "This file is larger than 5 MB. Split it into smaller files and import them one at a time.",
      );
      return;
    }
    setBusy(true);
    try {
      const text = await readFileAsText(file);
      if (!text.trim()) {
        setError("This file is empty.");
        setBusy(false);
        return;
      }
      const data = await api<ImportPreviewDto>("/contacts/import/preview", {
        method: "POST",
        body: { csv: text },
      });
      setCsv(text);
      setFileName(file.name);
      setPreview(data);
      setConfirmed(false);
      setStep("preview");
    } catch (err) {
      setError(
        err instanceof Error && err.message === "read_failed"
          ? "We couldn't read that file."
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function onImport(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!confirmed) {
      setConfirmError("Confirm you have a lawful basis to contact these people.");
      return;
    }
    setConfirmError(null);
    if (!csv) return;
    setBusy(true);
    try {
      const data = await api<ImportResultDto>("/contacts/import", {
        method: "POST",
        body: { csv, duplicates, confirmLawfulBasis: true },
      });
      setResult(data);
      setStep("done");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep("upload");
    setCsv(null);
    setPreview(null);
    setResult(null);
    setFileName(null);
    setError(null);
    setDuplicates("skip");
    setConfirmed(false);
  }

  const sampleColumns = preview
    ? (Object.values(preview.mapping).filter((f): f is ImportField => f !== null) as ImportField[])
    : [];

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/app/contacts" className="text-slate-600 hover:underline dark:text-slate-400">
          Contacts
        </Link>
        <span aria-hidden="true" className="mx-2 text-slate-400">
          /
        </span>
        <span aria-current="page">Import</span>
      </nav>
      <PageHeader
        title="Import contacts"
        description="Upload a CSV. You'll see exactly what will happen before anything is saved."
      />
      <StepIndicator step={step} />

      {error ? (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {step === "upload" ? (
        <Card className="max-w-2xl">
          <CardHeader title="1. Upload a CSV file" />
          <form onSubmit={onUpload} className="space-y-4 p-5">
            <div className="space-y-1.5">
              <Label htmlFor={fileId}>CSV file</Label>
              <input
                ref={fileRef}
                id={fileId}
                type="file"
                accept=".csv,text/csv"
                aria-describedby={fileHintId}
                className="block w-full text-sm text-slate-700 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:text-slate-300 dark:file:bg-indigo-950 dark:file:text-indigo-300"
              />
              <p id={fileHintId} className="text-xs text-slate-600 dark:text-slate-400">
                Up to 5 MB and 10,000 rows. Needs an email column; we&apos;ll detect names, titles,
                companies, phone, country and time zone automatically.
              </p>
            </div>
            <Button type="submit" loading={busy}>
              Preview import
            </Button>
          </form>
        </Card>
      ) : null}

      {step === "preview" && preview ? (
        <form onSubmit={onImport} className="space-y-6">
          <Card>
            <CardHeader
              title="2. Review"
              description={
                <>
                  {fileName} · {DELIMITER_LABELS[preview.delimiter]}-separated
                </>
              }
              actions={
                <Button variant="ghost" size="sm" onClick={reset}>
                  Choose a different file
                </Button>
              }
            />
            <dl className="grid grid-cols-2 gap-3 p-5 md:grid-cols-4">
              <Stat label="Rows read" value={preview.totalRows} />
              <Stat label="New" value={preview.newCount} />
              <Stat label="Duplicates" value={preview.duplicateCount} tone="warning" />
              <Stat label="Invalid" value={preview.invalidCount} tone="danger" />
            </dl>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Column mapping"
                description="How each column in your file will be used."
              />
              <Table caption="Detected column mapping" className="[&_table]:min-w-0">
                <thead>
                  <tr>
                    <Th>Column in file</Th>
                    <Th>Openline field</Th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(preview.mapping).map(([header, field]) => (
                    <tr key={header}>
                      <Td className="font-mono text-xs">{header}</Td>
                      <Td>{field ? FIELD_LABELS[field] : <Badge>Ignored</Badge>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>

            <Card>
              <CardHeader
                title="Invalid rows"
                description={
                  preview.invalidCount > preview.invalid.length
                    ? `Showing the first ${preview.invalid.length} of ${preview.invalidCount}. These rows will be skipped.`
                    : "These rows will be skipped."
                }
              />
              {preview.invalid.length === 0 ? (
                <p className="p-5 text-sm text-slate-600 dark:text-slate-400">
                  No invalid rows. Nice.
                </p>
              ) : (
                <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto text-sm dark:divide-slate-800">
                  {preview.invalid.map((r) => (
                    <li key={r.row} className="flex gap-3 px-5 py-2">
                      <span className="w-16 shrink-0 text-slate-500 tabular-nums dark:text-slate-400">
                        Row {r.row}
                      </span>
                      <span>{r.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {preview.sample.length > 0 ? (
            <Card>
              <CardHeader
                title="Sample rows"
                description="The first few contacts as they'll be saved."
              />
              <Table caption="Sample of contacts to import">
                <thead>
                  <tr>
                    {sampleColumns.map((f) => (
                      <Th key={f}>{FIELD_LABELS[f]}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((row, i) => (
                    <tr key={`${row.email}-${i}`}>
                      {sampleColumns.map((f) => (
                        <Td key={f} className="whitespace-nowrap">
                          {row[f] ?? "—"}
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Import options" />
            <div className="space-y-5 p-5">
              <fieldset>
                <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  When a contact already exists ({preview.duplicateCount.toLocaleString()} found)
                </legend>
                <div className="mt-2 space-y-2">
                  {(
                    [
                      ["skip", "Skip", "Keep existing contacts as they are."],
                      ["update", "Update existing", "Overwrite fields with values from this file."],
                    ] as const
                  ).map(([value, label, help]) => (
                    <label key={value} className="flex items-start gap-3 text-sm">
                      <input
                        type="radio"
                        name="duplicates"
                        value={value}
                        checked={duplicates === value}
                        onChange={() => setDuplicates(value)}
                        className="mt-0.5 h-4 w-4 accent-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                      />
                      <span>
                        <span className="font-medium">{label}</span>
                        <span className="block text-slate-600 dark:text-slate-400">{help}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div>
                <Checkbox
                  label="I confirm I have a lawful basis to contact these people (e.g. existing relationship or legitimate business interest) and will honour opt-outs."
                  checked={confirmed}
                  onChange={(e) => {
                    setConfirmed(e.target.checked);
                    if (e.target.checked) setConfirmError(null);
                  }}
                  required
                  aria-invalid={confirmError ? true : undefined}
                />
                {confirmError ? (
                  <p
                    role="alert"
                    className="mt-1 ml-7 text-xs font-medium text-red-700 dark:text-red-400"
                  >
                    {confirmError}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  loading={busy}
                  disabled={preview.newCount + preview.duplicateCount === 0}
                >
                  {duplicates === "update"
                    ? `Import ${preview.newCount.toLocaleString()} and update ${preview.duplicateCount.toLocaleString()}`
                    : `Import ${preview.newCount.toLocaleString()} ${preview.newCount === 1 ? "contact" : "contacts"}`}
                </Button>
                <Button variant="secondary" onClick={reset} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        </form>
      ) : null}

      {step === "done" && result ? (
        <Card className="max-w-2xl">
          <CardHeader title="3. Import complete" />
          <div className="space-y-5 p-5">
            <Alert tone="success">Your contacts have been imported.</Alert>
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Created" value={result.created} />
              <Stat label="Updated" value={result.updated} />
              <Stat label="Skipped" value={result.skipped} tone="warning" />
              <Stat label="Invalid" value={result.invalid} tone="danger" />
            </dl>
            <div className="flex flex-wrap gap-2">
              <Link href="/app/contacts" className={buttonClasses("primary")}>
                View contacts
              </Link>
              <Button variant="secondary" onClick={reset}>
                Import another file
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );
}
