import Link from "next/link";
import { Container, PageHero } from "@/components/site/blocks";
import { ContactForm } from "@/components/site/contact-form";
import { CONTACT_EMAILS } from "@/config/site";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Contact",
  description:
    "Talk to Openline about pricing, a demo for your team, or support. Or send us a message and a person will reply.",
  path: "/contact",
});

const options = [
  {
    title: "Sales and demos",
    body: "Questions about plans, a walkthrough for your team, or whether Openline fits how you sell.",
    email: CONTACT_EMAILS.sales,
  },
  {
    title: "Support",
    body: "Already a customer? Tell us what you were doing and what you expected to happen.",
    email: CONTACT_EMAILS.support,
  },
  {
    title: "Security",
    body: "Found a vulnerability? Please report it privately — see our disclosure policy.",
    email: CONTACT_EMAILS.security,
    link: { href: "/security#disclosure", label: "Responsible disclosure" },
  },
];

export default function ContactPage() {
  return (
    <>
      <PageHero eyebrow="Contact" title="Talk to a person">
        <p>
          We&apos;re a small team building Openline for teams like yours. Write to us and someone
          who works on the product will answer.
        </p>
      </PageHero>
      <Container className="grid gap-12 py-16 sm:py-20 lg:grid-cols-[1fr_1.4fr]">
        <section aria-labelledby="options-heading">
          <h2 id="options-heading" className="text-xl font-semibold">
            Email us directly
          </h2>
          <ul className="mt-6 space-y-4">
            {options.map((o) => (
              <li
                key={o.title}
                className="rounded-xl border border-slate-200 p-5 dark:border-slate-800"
              >
                <h3 className="font-semibold">{o.title}</h3>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{o.body}</p>
                <p className="mt-3 text-sm">
                  <a
                    href={`mailto:${o.email}`}
                    className="font-medium text-indigo-700 underline underline-offset-2 dark:text-indigo-300"
                  >
                    {o.email}
                  </a>
                  {o.link ? (
                    <>
                      {" · "}
                      <Link href={o.link.href} className="underline underline-offset-2">
                        {o.link.label}
                      </Link>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
            Looking for an answer right now? The{" "}
            <Link
              href="/help"
              className="font-medium text-indigo-700 underline dark:text-indigo-300"
            >
              help centre
            </Link>{" "}
            covers setup, sequences, compliance and deliverability.
          </p>
        </section>
        <section
          aria-labelledby="form-heading"
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 dark:border-slate-800 dark:bg-slate-900"
        >
          <h2 id="form-heading" className="text-xl font-semibold">
            Send us a message
          </h2>
          <p className="mt-1 mb-6 text-sm text-slate-600 dark:text-slate-400">
            Fields marked <span aria-hidden="true">*</span>
            <span className="sr-only">with an asterisk</span> are required. We use your details only
            to reply — see our{" "}
            <Link href="/privacy" className="underline">
              privacy policy
            </Link>
            .
          </p>
          <ContactForm />
        </section>
      </Container>
    </>
  );
}
