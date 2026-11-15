import { Container, CtaBand, SectionHeading } from "@/components/site/blocks";
import { PlanCompare } from "@/components/site/plan-compare";
import { PricingPlans } from "@/components/site/pricing-plans";
import { ADD_ONS, PRICING_FAQ } from "@/content/pricing";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Pricing",
  description:
    "Flat pricing per team, from $39 a month. Every feature on every plan, two months free on annual billing, and a 14-day free trial with no card.",
  path: "/pricing",
});

export default function PricingPage() {
  return (
    <>
      <section className="border-b border-slate-200 bg-gradient-to-b from-indigo-50/70 to-white dark:border-slate-800 dark:from-indigo-950/30 dark:to-slate-950">
        <Container className="py-14 sm:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">Pricing</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
              One flat price for your team. Every feature included.
            </h1>
            <p className="mt-5 text-lg text-slate-600 dark:text-slate-300">
              No per-seat maths, no feature tiers, no surprise overage bills. Try the Team plan free
              for 14 days — no card needed.
            </p>
          </div>
          <div className="mt-12">
            <PricingPlans />
          </div>
          <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
            Prices in USD, before any applicable taxes. Cancel any time in settings.
          </p>
        </Container>
      </section>

      <section aria-labelledby="compare-heading">
        <Container className="py-16 sm:py-20">
          <SectionHeading id="compare-heading" title="Compare every plan">
            <p>Plans differ only in limits and support. The product is the same.</p>
          </SectionHeading>
          <div className="mt-8">
            <PlanCompare />
          </div>
        </Container>
      </section>

      <section aria-labelledby="addons-heading" className="bg-slate-50 dark:bg-slate-900/40">
        <Container className="py-16 sm:py-20">
          <SectionHeading id="addons-heading" title="Add-ons">
            <p>Need a little more without changing plan? Add exactly what you need.</p>
          </SectionHeading>
          <ul className="mt-8 grid gap-4 md:grid-cols-3">
            {ADD_ONS.map((a) => (
              <li
                key={a.name}
                className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
              >
                <h3 className="font-semibold">{a.name}</h3>
                <p className="mt-1 text-2xl font-semibold tracking-tight">{a.price}</p>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{a.note}</p>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
            Over a limit? We warn you at 80% and 100%, then pause sending. We never charge you
            automatically, and your data stays readable after a downgrade.
          </p>
        </Container>
      </section>

      <section aria-labelledby="faq-heading">
        <Container className="py-16 sm:py-20">
          <SectionHeading id="faq-heading" title="Pricing questions" />
          <div className="mt-8 max-w-3xl divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {PRICING_FAQ.map((item) => (
              <details key={item.q} className="group py-1">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-md py-4 text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 [&::-webkit-details-marker]:hidden">
                  <span className="text-base">{item.q}</span>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    className="h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
                    fill="currentColor"
                  >
                    <path d="M5.2 7.2a1 1 0 0 1 1.4 0L10 10.6l3.4-3.4a1 1 0 1 1 1.4 1.4l-4.1 4.1a1 1 0 0 1-1.4 0L5.2 8.6a1 1 0 0 1 0-1.4Z" />
                  </svg>
                </summary>
                <p className="pb-4 text-slate-600 dark:text-slate-400">{item.a}</p>
              </details>
            ))}
          </div>
        </Container>
      </section>

      <CtaBand title="Start with the Team plan, free for 14 days." />
    </>
  );
}
