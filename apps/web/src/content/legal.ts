/**
 * DRAFT legal texts for a US B2B SaaS. Placeholders in [brackets] come from LEGAL in
 * config/site.ts or must be filled in by Harsh with a lawyer. Not legal advice.
 */
import { CONTACT_EMAILS, LEGAL, SCOUT_MODEL_DESCRIPTION } from "@/config/site";

const co = LEGAL.companyName;
const addr = LEGAL.address;

export const PRIVACY_POLICY = `
This policy explains what personal information ${co} ("Openline", "we", "us") collects, how we use it, and the choices you have. It covers our website, the Openline app and our emails to you.

## Who this policy is about {#who}

- **Visitors** to our website and people who contact us.
- **Users** — people with an Openline account. For account information, we decide how it's used (we are the "controller" or "business").
- **Prospects** — people whose details our customers upload to Openline to contact. For this **customer data**, our customer decides how it's used and we process it only on their instructions (we are the "processor" or "service provider"). If an Openline customer contacted you, please contact them first; we'll help them answer you.

## Information we collect {#collect}

**You give us:**

- account details: name, work email, password (stored only as a scrypt hash), workspace name and settings, including your business postal address;
- mailbox connection details: SMTP or IMAP server settings and credentials, or Google access tokens, stored encrypted;
- customer data you upload or create: contacts, companies, consent records, suppression entries, sequences and email content;
- messages you send us through the contact form or by email;
- billing details, once paid plans launch, handled by our payment provider.

**Collected automatically:**

- security and usage logs: IP address, browser user agent, sign-in times and actions written to your workspace's audit log;
- replies to your outreach, when you turn on reply detection for a mailbox (only messages that match an email you sent through Openline are kept; other email is ignored and not stored; attachments are not downloaded).

We do not use advertising trackers, analytics cookies or third-party pixels on our website or in the app.

## How we use information {#use}

- to provide, secure and support Openline, including sending your sequences and detecting replies;
- to run the compliance and deliverability checks you rely on (suppression, consent, send windows, caps);
- to send you service emails: verification, password resets, invites and important account notices;
- to answer your questions and requests;
- to prevent abuse, investigate security incidents and meet legal obligations.

We do not sell personal information, and we do not share it for cross-context behavioural advertising.

## Google user data {#google}

When you connect a Gmail or Google Workspace mailbox, Openline asks Google for permission to **send email** on your behalf. If you turn on reply detection, we also ask for permission to **read** messages so we can find replies to your outreach.

Openline's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. In particular:

- we use Google user data only to provide the features you see in Openline: sending your emails, detecting and showing replies, and drafting replies when you ask Scout to;
- we do not use it for advertising, and we do not sell it;
- we do not use it to train generalised AI or machine-learning models;
- people at Openline do not read it unless you ask us to (for support), it's needed for security or abuse investigations, or the law requires it;
- you can disconnect a mailbox at any time in Openline, or revoke access in your Google Account settings.

## AI features (Scout) {#ai}

Scout runs on ${SCOUT_MODEL_DESCRIPTION}. When you ask Scout for a draft or a reply label, the relevant contact fields, email text and (if you allow it) public pages of the contact's company website are sent to the model to produce the result. That data is **not retained by the model provider and is not used to train any AI model**. Owners and admins can turn Scout off for their workspace. See our [AI data policy](/security#ai-data-policy).

## Customer data belongs to our customers {#ownership}

Our customers own the customer data in their workspace. We process it only to provide Openline to them, keep it separated from other workspaces, and don't use one customer's data for another. A data processing agreement is available on request.

## Who we share information with {#sharing}

- **Subprocessors** that help us run Openline, listed on our [trust centre](/security#subprocessors);
- **your mail provider** (for example Google), to send and read email as you instructed;
- **professional advisers** and **authorities** where the law requires it, or to protect rights and safety;
- a **successor** if ${co} is involved in a merger or acquisition, under this policy's protections.

## Cookies {#cookies}

We use **only essential cookies** — the ones needed to keep you signed in and to protect your account. The main one is a session cookie (\`__Host-ol_session\`), which is httpOnly and expires after 14 days of inactivity and at most 90 days after you sign in. We don't use analytics, advertising or social media cookies, so there's nothing to opt in to and no cookie banner.

## How long we keep information {#retention}

- **Account data:** for as long as your account is open, then deleted within [retention period] unless the law requires us to keep it.
- **Customer data:** until the customer deletes it or closes the workspace, then deleted within [retention period] (backups roll off within [backup period]).
- **Suppression entries:** kept while the workspace exists, so that opt-outs keep being honoured.
- **Audit logs:** [audit log retention period].
- **Contact form messages:** [retention period].

## Your rights and choices {#rights}

Depending on where you live, you may have the right to access, correct, delete or receive a copy of your personal information, and to object to or restrict some uses. We honour these requests for users and visitors wherever they live.

**California (CCPA/CPRA):** you have the right to know what we collect and why, to delete and correct it, and to opt out of its sale or sharing (we do neither). We won't discriminate against you for using these rights.

**New Jersey and other US states with privacy laws:** you have the right to confirm whether we process your personal data, to access, correct, delete and obtain a copy of it, and to opt out of targeted advertising, sale and profiling with legal effects (we don't do these). If we decline a request, you can appeal by replying to our decision; we'll respond within the time the law allows.

**EU, EEA and UK:** you have the rights above, can withdraw consent at any time, and may complain to your local data protection authority.

To make a request, email ${CONTACT_EMAILS.privacy}. We'll verify your identity before acting, and an authorised agent may make a request for you. If you're a prospect in a customer's workspace, we'll pass your request to that customer and support them in answering it.

## Security {#security}

We protect information with workspace isolation enforced in the database, encryption of mailbox credentials (AES-256-GCM), TLS in transit and an append-only audit log. No system is perfectly secure; read more on our [trust centre](/security).

## International transfers {#transfers}

We operate in the United States, and information is processed there [hosting region to be confirmed]. Where the law requires it, we use appropriate safeguards for transfers.

## Children {#children}

Openline is a business service and is not directed to anyone under 16. We don't knowingly collect their information.

## Changes to this policy {#changes}

If we make material changes, we'll update the date below and tell account owners by email or in the app before the changes take effect.

## Contact us {#contact}

${co}, ${addr}. Email: ${CONTACT_EMAILS.privacy}.
`;

export const TERMS_OF_SERVICE = `
These Terms of Service ("Terms") are an agreement between ${co} ("Openline", "we", "us") and the business or organisation that signs up ("Customer", "you"). By creating an account or using Openline, you agree to them. If you accept them for an organisation, you confirm you have authority to bind it.

## 1. Accounts {#accounts}

- You must be at least 18 and use Openline for business purposes.
- Give accurate information and keep it up to date, including your workspace's postal address.
- Keep passwords secure. You're responsible for everything done in your workspace, including by the users you invite, and for choosing their roles.
- Tell us promptly at ${CONTACT_EMAILS.security} if you suspect unauthorised access.

## 2. Free trial {#trial}

New workspaces may try the Team plan free for 14 days without a payment card. We may change or end trial offers for future sign-ups, and we may limit trials to prevent abuse.

## 3. Acceptable use and anti-spam rules {#acceptable-use}

Openline is for relevant, lawful business outreach. You must not use it to:

- send email to purchased, rented, scraped or harvested lists, or to people you have no lawful basis to contact;
- send to anyone who has unsubscribed or asked not to be contacted, or remove such people from your suppression list;
- use false or misleading sender names, headers or subject lines, or hide who you are;
- send phishing, malware, illegal content, or content that harasses, threatens or deceives;
- get around Openline's sending limits, spacing, caps, compliance checks or bounce protections, for example by rotating accounts or domains to evade them;
- email consumers for purposes the law restricts, or use Openline for any calls or texts in breach of the TCPA or similar laws when those features exist;
- probe, attack, overload or reverse-engineer the service, or access other customers' data;
- resell Openline or use it to build a competing product.

We may suspend sending or an account, with notice where practical, if we reasonably believe these rules are being broken or a mailbox is harming deliverability for others.

## 4. Your compliance responsibilities {#compliance}

You are the sender of every email you send through Openline. You are responsible for complying with the laws that apply to your outreach, including CAN-SPAM, CASL, GDPR and ePrivacy rules, and US state laws. In particular, you are responsible for:

- having a lawful basis or consent for each contact, and for the accuracy of the consent records you enter or import;
- the content of your emails, and an accurate postal address;
- honouring opt-out requests you receive outside Openline;
- the lists you import, which you confirm were collected lawfully.

Openline's compliance features are tools that help you follow these rules. They are not legal advice and do not guarantee that your outreach complies with the law.

## 5. Customer data {#customer-data}

You own the data you put into Openline ("Customer Data"). You give us permission to host, process and transmit it only as needed to provide, secure and support Openline, as described in our [Privacy Policy](/privacy). You're responsible for having the rights to the Customer Data you upload. We won't use Customer Data to train AI models.

## 6. Scout and AI output {#ai}

Scout's drafts and labels are suggestions and may be incomplete or wrong. Nothing Scout drafts is sent without approval by a user, and you are responsible for reviewing what you approve and send. AI features are subject to the monthly credit budget for your plan and may be turned off by your owners and admins.

## 7. Plans, fees and payment {#payment}

- Prices are listed on our [pricing page](/pricing) in US dollars, charged per workspace, in advance, monthly or annually, plus applicable taxes.
- If you reach a plan limit, we'll warn you and pause the affected activity (such as sending) rather than charge you automatically. Add-ons and upgrades are charged only when you choose them.
- We may change prices for future billing periods with at least [notice period] days' notice. Changes don't affect a period you've already paid for.
- Unpaid amounts may lead to sending being paused, then the account being suspended after notice.

## 8. Cancellation and termination {#cancellation}

- You can cancel at any time in your workspace settings. Cancellation takes effect at the end of your current billing period; [refund policy].
- After a downgrade, data over the new plan's limits stays readable; sending waits until you're within the limits.
- We may terminate these Terms if you materially breach them and don't fix the breach within [cure period] days of notice, or immediately for serious abuse of the acceptable use rules.
- After the account ends, you can export your Customer Data for [export window] days; then we delete it as described in our Privacy Policy.

## 9. Intellectual property {#ip}

We own Openline, including its software, design and documentation. These Terms give you a limited, non-exclusive, non-transferable right to use Openline during your subscription. If you send us feedback, we may use it without obligation to you.

## 10. Third-party services {#third-party}

Openline connects to services you choose, such as Google or your email provider. Your use of them is governed by their terms, and we're not responsible for their availability or actions.

## 11. Confidentiality {#confidentiality}

Each party will protect the other's non-public information with reasonable care and use it only for this agreement, except where disclosure is required by law.

## 12. Disclaimers {#disclaimers}

Openline is provided "as is" and "as available". To the fullest extent the law allows, we disclaim all implied warranties, including merchantability, fitness for a particular purpose and non-infringement. We don't promise that any email will be delivered, reach an inbox or get a reply, or that the service will be uninterrupted or error-free.

## 13. Limitation of liability {#liability}

To the fullest extent the law allows: neither party is liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue or data; and each party's total liability under these Terms is limited to the fees you paid us in the 12 months before the claim. These limits don't apply to your payment obligations, your breach of section 3 or 4, or either party's liability that cannot be limited by law.

## 14. Indemnity {#indemnity}

You will defend and indemnify ${co} against third-party claims arising from your Customer Data, your emails, or your breach of sections 3 or 4, including claims under anti-spam and privacy laws.

## 15. Governing law and disputes {#law}

These Terms are governed by the laws of ${LEGAL.governingLaw}, without regard to its conflict-of-laws rules. The state and federal courts located in [County], New Jersey have exclusive jurisdiction, and both parties consent to them.

## 16. Changes to these Terms {#changes}

We may update these Terms. For material changes we'll give account owners at least [notice period] days' notice by email or in the app. Continuing to use Openline after the changes take effect means you accept them.

## 17. General {#general}

These Terms, with any order form and the Privacy Policy, are the whole agreement between us about Openline. If a provision is unenforceable, the rest still applies. Neither party may assign these Terms without the other's consent, except to a successor in a merger or acquisition. Failure to enforce a provision isn't a waiver.

## 18. Contact {#contact}

${co}, ${addr}. Email: ${CONTACT_EMAILS.hello}.
`;
