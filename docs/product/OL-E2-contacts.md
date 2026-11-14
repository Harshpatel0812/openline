# PRD: Contacts, CSV import and suppression list

Epic: OL-E2 Sprint: S2 Owner: Harsh Status: Draft

## Problem

A new team's first act in any outreach tool is getting its prospects in. Today those prospects
sit in spreadsheets and exports from other tools (old CRMs, LinkedIn, list providers), usually
several files with overlapping people. Importers in existing tools fail on ordinary files (Excel's
semicolon-separated or BOM-prefixed CSVs), silently create duplicates, or save half a file and say
"done". The costs show up later: duplicate emails to the same person, bounces from bad addresses
that hurt the sender's domain, and — the expensive one — mailing someone who already opted out,
which CAN-SPAM penalises per email. Teams need a fast import that shows what will happen before
it happens, and one list of "never contact" addresses that every later send respects.

## Goal and success metric

A new team gets its existing contacts into Openline quickly and cleanly — no duplicates, no
surprises, opt-outs respected from day one.

Metric: median time for a workspace's first import of about 1,000 rows, from opening the import
page to "Import complete", is under 2 minutes (measured from `import.page_opened` to
`import.completed` events).

## User stories and acceptance criteria

- As a rep, I want to add, find, view and edit contacts, so that my prospects are in one place.
  - [ ] Given I create a contact with email `Jane.Doe@Acme.com`, when it saves, then the email is
        stored as `jane.doe@acme.com`, a company with domain `acme.com` is created if none exists
        (or the existing one is linked), and the contact's consent basis is `none`. Email is the
        only required field; first name, last name, title, phone, company domain, time zone (IANA,
        e.g. `America/Toronto`) and country (ISO 3166-1 alpha-2) are optional and validated.
  - [ ] Given a contact `jane@acme.com` exists, when anyone creates or edits a contact to
        `JANE@acme.com`, then the API returns 409 `duplicate_contact` "A contact with this email
        already exists." with a link to the existing contact, and nothing is saved.
  - [ ] Given a contact's email domain is a free-mail domain (`FREE_MAIL_DOMAINS` in
        `packages/shared`: gmail.com, googlemail.com, yahoo.com, ymail.com, outlook.com,
        hotmail.com, live.com, msn.com, icloud.com, me.com, aol.com, proton.me, protonmail.com,
        gmx.com, mail.com and the others in that list), when it saves without a company domain,
        then no company is created or linked. A non-free-mail company domain entered explicitly
        wins over the email domain.
  - [ ] Given a workspace with contacts, when I open Contacts, then I see 50 per page, newest
        first, with next/previous pages and a total count; typing in search filters by first name,
        last name, full name, email or company name/domain (case-insensitive, contains), and `%`
        or `_` in the search are matched literally. With 50,000 contacts, list and search respond
        in under 300 ms at p95.
  - [ ] Given I open a contact, when I edit any field and save, then changes are validated with the
        same rules as create; changing the email or company domain re-links the company; setting a
        consent basis other than `none` requires the date consent was obtained and a source note,
        and is written to the audit log with before/after.
  - [ ] Given I am an owner, admin or manager, when I delete a contact and confirm, then the contact
        and its consent records are permanently deleted and an audit entry records the contact id
        and who deleted it (not the email). Owners and admins also see "Add this email to the
        suppression list", checked by default. Given I am a rep, the delete endpoint returns 403.
  - [ ] Given two workspaces A and B, when a user of A requests a B contact, company, import or
        suppression by id, then the API returns 404; queries run with `app.workspace_id` = A
        return no B rows; a cross-tenant test exists for each new table.
- As a rep, I want to import a CSV and see exactly what will happen before anything is saved, so
  that I don't create duplicates or junk.
  - [ ] Given a file over 5 MB or with more than 10,000 data rows (header excluded), when I upload
        it, then it is rejected before preview with "This file has 12,345 rows. The limit is
        10,000 — split it and import the parts." (or the size equivalent); no rows are truncated
        silently. A file that is not text CSV (e.g. `.xlsx`) is rejected with "Save the file as
        CSV UTF-8 and try again."
  - [ ] Given a valid file, when upload finishes, then a preview shows: rows read; new contacts;
        duplicates of existing contacts; invalid rows with row number and reason (missing email,
        invalid email, invalid country, invalid time zone, invalid company domain, value too long,
        duplicate of row N in this file); contacts matching the suppression list; and the detected
        column mapping, which I can change (the preview recalculates). Unmapped columns are listed
        as ignored. Nothing is written to contacts or companies until I confirm.
  - [ ] Given a CSV saved by Excel with a UTF-8 BOM, when it is previewed, then the BOM is stripped
        and the first column (`Email`) is detected like any other header.
  - [ ] Given a semicolon-separated (or tab-separated) file, when it is previewed, then the
        delimiter is auto-detected from the header row, quoted fields with embedded delimiters,
        quotes and line breaks are parsed per RFC 4180, and the detected delimiter is shown.
  - [ ] Given a file with no column recognised as email (headers matched case-insensitively against
        `email`, `e-mail`, `email address`, `work email` and the other synonyms in
        `packages/shared`), when it is previewed, then the preview says "We couldn't find an email
        column. Choose which column holds email addresses." and Import stays disabled until one is
        mapped.
  - [ ] Given a file where `Jane@acme.com` (row 2) and `jane@ACME.com` (row 9) both appear, when
        previewed, then row 2 counts once (as new or duplicate of existing) and row 9 is invalid
        with "Duplicate of row 2 in this file".
  - [ ] Given duplicates of existing contacts, when I choose "Skip" they are left untouched; when I
        choose "Update existing", only non-empty cells overwrite existing fields (a blank cell
        never erases data), the email itself never changes, and an imported consent basis never
        replaces an existing non-`none` basis. Default is "Skip".
  - [ ] Given I map columns to consent basis (`express`, `implied_purchase`, `implied_inquiry`,
        `legitimate_interest`, `none`) and consent date, when previewed, then rows with a basis
        other than `none` and no valid date are invalid ("Consent basis needs a date"); with no
        mapping every imported contact gets `none`. Rows with country `CA` and basis `none` are
        counted with the warning "N Canadian contacts have no consent on record. Openline will
        block emailing them (CASL) until consent is recorded." — they still import.
  - [ ] Given the preview, when I click Import, then I must first tick "These contacts were
        collected lawfully and are not a purchased or scraped list"; the attestation, my user id
        and time are stored on the import record.
  - [ ] Given I confirm, when the import runs, then it runs as a background job in one database
        transaction (all valid rows saved or none), duplicates are re-checked at commit time, a
        second click or repeated request does not start a second import, and the result shows final
        counts with a download of invalid rows as CSV (cells starting with `=`, `+`, `-`, `@` are
        prefixed with `'` to block spreadsheet formula injection). A 10,000-row file previews in
        under 10 s and commits in under 30 s.
- As an owner or admin, I want a suppression list, so that people who must never be contacted are
  never contacted, whoever imports them.
  - [ ] Given I am an owner or admin, when I add `jane@acme.com` or `@acme.com` (one value, or up to
        1,000 pasted one per line) with a reason (unsubscribed, asked not to be contacted,
        existing customer, competitor, legal, other), then each value is trimmed and lower-cased,
        invalid or duplicate values are reported per line, and matching contacts show a
        "Suppressed" badge in the list and detail. Adding a free-mail domain (e.g. `@gmail.com`)
        asks for confirmation first. Given I am a manager or rep, add and remove return 403; I can
        see that a contact is suppressed but not the list.
  - [ ] Given a suppression entry, when an owner or admin removes it, then they must confirm, the
        removal is audit-logged with value and reason, and entries with reason "unsubscribed" or
        "asked not to be contacted" cannot be removed from the UI. Later sends call
        `isSuppressed()` from `packages/compliance` against this table (no sending in this sprint).

## Out of scope

- Sending, sequences and unsubscribe links (the unsubscribe flow will write to the suppression
  list in a later sprint).
- Company pages, company editing, merging companies; deriving the registrable domain for
  subdomains (`jane@eu.acme.com` → company `eu.acme.com` in Sprint 2).
- Custom fields, tags, lists, owners/assignment rules, bulk edit and bulk delete.
- Import from Excel files, Google Sheets or other CRMs' APIs; undoing an import.
- Contact export and data-subject access requests (handled by runbook until a later sprint).
- Email verification or bounce prediction at import (Inbox Guardian, v2).
- Inferring time zone from country or phone.

## Design

No mockups yet; built with `packages/ui`. Screens: Contacts list (search, pagination, Suppressed
badge, Import and New contact buttons), Contact detail/edit (with consent basis, delete), Import:
upload → preview (counts, mapping table, invalid rows, warnings, duplicate choice, attestation) →
progress → result; Settings → Suppression list (owner/admin).

## Data, security and compliance

- New tables/columns (and their RLS policy):
  - `contacts` (exists): enforce lower-case email in the database (`CHECK (email = lower(email))`)
    so the existing unique `(workspace_id, email)` is case-insensitive even if a code path skips the
    Zod transform; add `import_id` (nullable FK → imports); `country` CHECK as 2 upper-case
    letters; trigram (pg_trgm) GIN indexes for search on names, email and company. Existing RLS.
  - `companies` (exists): created with `name` = domain; insert uses `ON CONFLICT (workspace_id,
domain)` so two concurrent imports cannot create the same company twice. Existing RLS.
  - `consents` (exists) is the source of truth for consent: imports create rows with source
    `import:<import id>`, manual edits `manual:<user id>`. The API's `consentBasis` on a contact
    is the latest non-withdrawn record, or `none` when there is none.
  - `suppressions` (exists): add `created_by`; `reason` becomes an enum; CHECK that `value` is
    lower-case and is either an email or `@` + domain. Existing RLS.
  - `imports` — new tenant table: `id`, `workspace_id`, `created_by`, `file_name`, `file_key`,
    `status` (`previewed` → `importing` → `completed` | `failed` | `expired`), `delimiter`,
    `mapping` (json), `duplicate_mode`, `counts` (json), `attested_at`, `created_at`,
    `completed_at`. Gets the `tenant_isolation` RLS policy in its migration.
  - `packages/shared`: extend `ContactInputSchema` (time zone, country, consent basis + date),
    add `FREE_MAIL_DOMAINS`, CSV header synonyms, `QUEUES.CONTACTS_IMPORT = "contacts-import"`,
    error codes `duplicate_contact`, `import_too_large`, `import_not_csv`, `no_email_column`.
  - CSV parser: a maintained streaming parser is a new dependency; the PR must name it and why.
- Personal data touched, retention:
  - Contacts' names, work emails, titles, phone numbers, company, country, time zone, consent
    records. Contacts are kept until a user deletes them or the workspace is deleted; delete is a
    hard delete.
  - Uploaded files: private object storage (encrypted at rest, keys prefixed by workspace), deleted
    on commit or 24 hours after upload, whichever is first; imports not confirmed in 24 hours become
    `expired`. The invalid-rows CSV is generated on request from the import record and is not
    stored.
  - Suppression entries are kept until removed (opt-outs indefinitely); they hold only the email or
    domain and reason.
  - Logs and job payloads carry ids and counts only — never emails, names or row contents.
- Threats considered (abuse, tenant leak, injection):
  - Tenant leak: RLS on every table above, workspace id from the session, 404 for other
    workspaces' ids, cross-tenant tests; the import job sets `app.workspace_id` from the import
    record, not from the job payload alone, and checks they match.
  - CSV/formula injection: values stored as text and rendered as text; exports escape leading
    `= + - @`.
  - SQL injection via search: parameterised queries, LIKE wildcards escaped.
  - Resource abuse: 5 MB / 10,000-row limits checked while streaming (stop reading past the
    limit), max 10 imports per workspace per hour, one running import per workspace at a time.
  - Malformed input: invalid UTF-8 rejected with a clear message; rows that fail validation never
    reach the database.
  - Bad lists: required attestation, CASL warning, suppression matches shown in preview; blocking
    happens at send time (deterministic checks in `packages/compliance`, never an LLM).
  - Race conditions: duplicate check and company upsert repeated inside the commit transaction;
    import status transitions guarded so a confirm is processed once.
- Legal rules involved (CAN-SPAM, TCPA, CASL, state privacy):
  - CAN-SPAM (US): opt-out model, so `none` is a valid basis for US contacts, but opt-outs must
    be honoured within 10 business days and permanently. The suppression list is where opt-outs
    live; protected reasons cannot be removed from the UI, and deleting a contact offers to suppress
    it so a re-import cannot bring a person back.
  - CASL (Canada): sender carries the burden of proof of consent. Consent needs a basis, date and
    source (stored in `consents`); implied consent expires (24 months purchase, 6 months inquiry,
    see `packages/compliance/src/consent.ts`). Canadian contacts with `none` are flagged at import
    and blocked at send.
  - TCPA (US): we store phone numbers, but storing or importing a phone is not consent to call or
    text. No calling or SMS exists in this sprint; any later calling feature needs its own consent
    records.
  - US state privacy laws (CCPA/CPRA, Virginia, Colorado and others): our customers are the
    businesses; Openline processes contact data on their behalf only for their outreach, never
    sells or shares it across workspaces, and supports deleting a person on request (hard delete
    plus optional suppression). Keeping a suppressed email after a deletion request so we can
    honour the opt-out needs legal confirmation.

## Open questions

1. Can reps delete contacts, or only owner/admin/manager (as written)? And can reps import at all,
   or should import be manager and above?
2. Should we require the lawful-collection attestation on every import (as written) or only once
   per workspace?
3. Keep a suppressed email after a "delete my data" request? Proposed yes (minimum needed to
   honour the opt-out); needs a lawyer's confirmation.
4. Company name for auto-created companies: the domain (`acme.com`, as written) or a guess
   (`Acme`)? And should subdomains roll up to the registrable domain (needs the Public Suffix
   List, a new dependency)?
5. Many Windows Excel users save CSVs as Windows-1252, not UTF-8. Reject them (as written) or
   auto-detect and convert?
6. Per-workspace contact cap during the trial (e.g. 50,000) to limit abuse before billing exists?
