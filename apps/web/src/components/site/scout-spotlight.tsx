import Link from "next/link";
import { SCOUT_MODEL_DESCRIPTION } from "@/config/site";
import { Container } from "./blocks";

const examples = [
  {
    ask: "Draft a first email to Dana at Brightwell Freight about our route-planning tool.",
    outcome:
      "Scout reads up to three pages of brightwell-freight.com and writes a short opener. Every specific line about Brightwell shows where it came from, so you can check it in a click.",
  },
  {
    ask: "Reply to Marco — he asked whether we integrate with his billing system.",
    outcome:
      "Scout drafts an answer in the same thread, using only what's in the conversation and your workspace's product notes. If it doesn't know, it says so instead of guessing.",
  },
  {
    ask: "Priya wrote “not this quarter, try me in spring.” What should I send?",
    outcome:
      "The reply is already labelled Not now and her sequence has stopped. Scout suggests a two-line, no-pressure answer you can edit before it goes anywhere.",
  },
];

export function ScoutSpotlight() {
  return (
    <section
      aria-labelledby="scout-heading"
      className="border-y border-slate-200 bg-slate-950 text-white dark:border-slate-800"
    >
      <Container className="py-16 sm:py-24">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold text-indigo-300">Meet Scout</p>
          <h2
            id="scout-heading"
            className="mt-2 text-2xl font-semibold tracking-tight text-balance sm:text-3xl"
          >
            An AI assistant that cites its sources and waits for your yes.
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-300">
            Scout drafts first-touch emails and replies from facts it can point to. You read, edit,
            approve or reject. It runs on {SCOUT_MODEL_DESCRIPTION}, and your data is never used to
            train models.
          </p>
        </div>
        <ul className="mt-10 grid gap-4 lg:grid-cols-3">
          {examples.map((ex) => (
            <li
              key={ex.ask}
              className="flex flex-col rounded-xl border border-slate-800 bg-slate-900 p-5"
            >
              <p className="text-xs font-semibold tracking-wide text-indigo-300 uppercase">
                You ask
              </p>
              <p className="mt-2 text-base font-medium text-white">“{ex.ask}”</p>
              <p className="mt-5 text-xs font-semibold tracking-wide text-emerald-300 uppercase">
                What happens
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-300">{ex.outcome}</p>
            </li>
          ))}
        </ul>
        <p className="mt-8 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
            <path d="M10 1.5 3 4.3v5c0 4.2 2.9 7.9 7 9.2 4.1-1.3 7-5 7-9.2v-5l-7-2.8Z" />
          </svg>
          Nothing is sent without your approval.
        </p>
        <p className="mt-4 text-sm text-slate-400">
          <Link href="/help/scout" className="underline underline-offset-2 hover:text-white">
            How Scout works
          </Link>{" "}
          ·{" "}
          <Link
            href="/security#ai-data-policy"
            className="underline underline-offset-2 hover:text-white"
          >
            AI data policy
          </Link>
        </p>
      </Container>
    </section>
  );
}
