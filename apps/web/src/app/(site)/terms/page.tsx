import { LegalPage } from "@/components/site/legal-page";
import { TERMS_OF_SERVICE } from "@/content/legal";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Terms of Service",
  description:
    "The terms for using Openline: accounts, acceptable use and anti-spam rules, your compliance responsibilities, payment, cancellation and liability.",
  path: "/terms",
});

export default function TermsPage() {
  return <LegalPage title="Terms of Service" source={TERMS_OF_SERVICE} />;
}
