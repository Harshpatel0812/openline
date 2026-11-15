import Link from "next/link";
import { Container, CtaBand, PageHero } from "@/components/site/blocks";
import { CONTACT_EMAILS, SCOUT_MODEL_DESCRIPTION, SECURITY_POLICY_URL } from "@/config/site";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Security and trust",
  description:
    "How Openline protects your data: workspace isolation with row-level security, encrypted mailbox credentials, TLS, an audit log, Scout's AI data policy and our subprocessors.",
  path: "/security",
});

const protections = [
  {
    title: "Workspace isolation",
    body: "Every workspace's records are separated twice: application code always filters by workspace, and PostgreSQL row-level security enforces it again in the database. Automated tests try to read across workspaces on every change. Another workspace's record looks exactly like one that doesn't exist.",
  },
  {
    title: "Encrypted mailbox credentials",
    body: "SMTP passwords and Google access tokens are sealed with AES-256-GCM before they're stored, and are never shown again or written to logs — not even to your admins.",
  },
  {
    title: "Encryption in transit",
    body: "The app is served over TLS only (HSTS). Connections to your mail servers use TLS with certificate checks switched on.",
  },
  {
    title: "No real email outside production",
    body: "Development and staging environments can't email real prospects. Only our production environment sends outreach, so a test can never reach your contacts.",
  },
  {
    title: "Audit log",
    body: "Sign-ins, role changes, invites, mailbox changes, imports, consent changes, suppressions and unsubscribes are written to an append-only log. The application can add entries but can't change or delete them.",
  },
  {
    title: "Accounts and sessions",
    body: "Passwords are hashed with scrypt and must be at least 12 characters. Sessions are server-side, in httpOnly cookies, and a password reset signs out every session.",
  },
  {
    title: "Web protections",
    body: "A strict, per-request Content-Security-Policy, CSRF protection on every change, rate limits on sign-in and sign-up, and request size limits.",
  },
  {
    title: "Careful logging",
    body: "We never log email bodies, mailbox credentials or tokens. Database errors are logged as codes, without the data that caused them.",
  },
];

const aiRules = [
  {
    title: "Approve first",
    body: "Scout proposes; a person decides. Every draft waits for someone to approve, edit or reject it, and Scout can't send, delete or change anything by itself.",
  },
  {
    title: "Cite or stay silent",
    body: "Every specific claim Scout makes about a prospect points to its source. If there's no source, the claim doesn't go in.",
  },
  {
    title: "Fewer, better touches",
    body: "Scout helps you write one good email, not a hundred average ones. It never decides who to email or whether an email is legal to send — that's deterministic code.",
  },
  {
    title: "Your data stays yours",
    body: `Scout runs on ${SCOUT_MODEL_DESCRIPTION}. Your contacts, emails and replies are never used to train AI models, ours or anyone else's.`,
  },
  {
    title: "Show confidence",
    body: "When Scout labels a reply, you can see how sure it was, and labels from simple rules are marked as such. You can always change a label.",
  },
];

const subprocessors = [
  {
    name: "Amazon Web Services (AWS)",
    purpose: "Hosting, database and storage for the Openline service",
    region: "US (to be confirmed)",
  },
  {
    name: "Google",
    purpose: "Gmail API, only when you connect a Gmail or Google Workspace mailbox",
    region: "Per Google's terms",
  },
  {
    name: "AI model provider via AWS Bedrock",
    purpose: "Scout's drafts and reply labels, with zero data retention",
    region: "US (to be confirmed)",
  },
];

export default function SecurityPage() {
  return (
    <>
      <PageHero eyebrow="Trust centre" title="Security and trust at Openline">
        <p>
          Openline connects to your team&apos;s mailboxes and holds your prospect list. We treat
          that as a responsibility, not a feature. Here&apos;s how we look after it — in plain
          language, without claims we can&apos;t back up.
        </p>
      </PageHero>

      <Container className="py-16 sm:py-20">
        <section aria-labelledby="protect-heading">
          <h2 id="protect-heading" className="text-2xl font-semibold tracking-tight">
            How your data is protected
          </h2>
          <ul className="mt-8 grid gap-4 md:grid-cols-2">
            {protections.map((p) => (
              <li
                key={p.title}
                className="rounded-xl border border-slate-200 p-5 dark:border-slate-800"
              >
                <h3 className="font-semibold">{p.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
                  {p.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="ai-data-policy" className="mt-20 scroll-mt-24">
          <h2 id="ai-data-policy" className="text-2xl font-semibold tracking-tight">
            AI data policy: Scout&apos;s five rules
          </h2>
          <p className="mt-3 max-w-3xl text-slate-600 dark:text-slate-400">
            Emails from prospects and text from websites are treated as untrusted data and are never
            followed as instructions. Owners and admins can turn Scout off for the whole workspace
            at any time; with Scout off, nothing is sent to the AI model.
          </p>
          <ol className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {aiRules.map((r, i) => (
              <li key={r.title} className="rounded-xl bg-slate-50 p-5 dark:bg-slate-900">
                <p className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">
                  Rule {i + 1}
                </p>
                <h3 className="mt-1 font-semibold">{r.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
                  {r.body}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="subprocessors" className="mt-20 scroll-mt-24">
          <h2 id="subprocessors" className="text-2xl font-semibold tracking-tight">
            Subprocessors
          </h2>
          <p className="mt-3 max-w-3xl text-slate-600 dark:text-slate-400">
            These companies process customer data on our behalf. We&apos;ll update this list before
            adding a new one.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <caption className="sr-only">Openline subprocessors</caption>
              <thead>
                <tr className="border-b border-slate-300 dark:border-slate-700">
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    Subprocessor
                  </th>
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    Purpose
                  </th>
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    Data location
                  </th>
                </tr>
              </thead>
              <tbody>
                {subprocessors.map((s) => (
                  <tr key={s.name} className="border-b border-slate-200 dark:border-slate-800">
                    <th scope="row" className="py-3 pr-4 align-top font-medium">
                      {s.name}
                    </th>
                    <td className="py-3 pr-4 align-top text-slate-700 dark:text-slate-300">
                      {s.purpose}
                    </td>
                    <td className="py-3 pr-4 align-top text-slate-700 dark:text-slate-300">
                      {s.region}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="disclosure" className="mt-20 scroll-mt-24">
          <h2 id="disclosure" className="text-2xl font-semibold tracking-tight">
            Responsible disclosure
          </h2>
          <div className="mt-3 max-w-3xl space-y-3 text-slate-600 dark:text-slate-400">
            <p>
              If you believe you&apos;ve found a security vulnerability in Openline, please email{" "}
              <a
                href={`mailto:${CONTACT_EMAILS.security}`}
                className="font-medium text-indigo-700 underline dark:text-indigo-300"
              >
                {CONTACT_EMAILS.security}
              </a>{" "}
              with the steps to reproduce it. Please don&apos;t open a public issue, access other
              customers&apos; data, or degrade the service while testing.
            </p>
            <p>
              We acknowledge reports within one business day and keep you updated until the issue is
              fixed. Our full policy is in{" "}
              <a
                href={SECURITY_POLICY_URL}
                className="font-medium text-indigo-700 underline dark:text-indigo-300"
                rel="noopener noreferrer"
                target="_blank"
              >
                SECURITY.md
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              .
            </p>
          </div>
        </section>

        <p className="mt-16 text-sm text-slate-600 dark:text-slate-400">
          Questions about security or privacy? See our{" "}
          <Link href="/privacy" className="underline">
            privacy policy
          </Link>{" "}
          or email{" "}
          <a href={`mailto:${CONTACT_EMAILS.security}`} className="underline">
            {CONTACT_EMAILS.security}
          </a>
          .
        </p>
      </Container>
      <CtaBand />
    </>
  );
}
