import { LegalPage } from "@/components/site/legal-page";
import { PRIVACY_POLICY } from "@/content/legal";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Privacy Policy",
  description:
    "What personal information Openline collects, how we use it, Google user data and Limited Use, AI, cookies, retention and your privacy rights.",
  path: "/privacy",
});

export default function PrivacyPage() {
  return <LegalPage title="Privacy Policy" source={PRIVACY_POLICY} />;
}
