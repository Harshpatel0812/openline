"use client";

import Link from "next/link";
import { PageHeader } from "@/components/app/app-shell";
import { useMe } from "@/components/app/me-context";
import { Badge, Card, CardHeader } from "@/components/ui";

const steps = [
  {
    title: "Import contacts",
    body: "Bring in a CSV. We flag duplicates and invalid rows before anything is saved.",
    href: "/app/contacts/import",
    cta: "Import a CSV",
  },
  {
    title: "Invite your team",
    body: "Add reps and managers so everyone works from one suppression list.",
    href: "/app/settings/team",
    cta: "Invite teammates",
  },
  {
    title: "Connect a mailbox",
    body: "Send from your own Google or Microsoft mailbox with guardrails on by default.",
    soon: true,
  },
];

export default function TodayPage() {
  const { me } = useMe();
  const firstName = me.user.name.split(" ")[0] || me.user.name;
  return (
    <>
      <PageHeader
        title={`Welcome, ${firstName}`}
        description="Your daily focus list lives here once sequences launch. For now, let's get your workspace ready."
      />
      <Card className="max-w-2xl">
        <CardHeader
          title="Get started"
          description={`Three steps to set up ${me.workspace.name}.`}
        />
        <ol className="divide-y divide-slate-200 dark:divide-slate-800">
          {steps.map((step, i) => (
            <li key={step.title} className="flex gap-4 px-5 py-4">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-300 text-sm font-medium text-slate-600 dark:border-slate-700 dark:text-slate-400"
              >
                {i + 1}
              </span>
              <div className="flex-1">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {step.title}
                  {step.soon ? <Badge>Soon</Badge> : null}
                </h3>
                <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{step.body}</p>
                {step.href ? (
                  <Link
                    href={step.href}
                    className="mt-2 inline-block rounded text-sm font-medium text-indigo-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 dark:text-indigo-400"
                  >
                    {step.cta} →
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
