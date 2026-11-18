import type { HelpArticle } from "./types";

/** Sprint 7 (OL-E8): two-way HubSpot and Pipedrive sync. Keep true to docs/product/OL-E8-crm-sync.md. */
export const crmSync: HelpArticle[] = [
  {
    slug: "crm-sync",
    category: "integrations",
    title: "Sync with HubSpot or Pipedrive",
    summary:
      "Connect one CRM, preview the import, then keep contacts, companies and deals in step both ways. Opt-outs travel to the CRM; re-subscribes never come back.",
    updated: "2026-11-16",
    body: `
Openline keeps **contacts, companies and deals** in step with **HubSpot** or **Pipedrive**, in both directions, so nobody types a deal twice and a person who unsubscribed in one tool stays unsubscribed in the other.

CRM sync is included in the **Team**, **Growth** and **Scale** plans (and in the free trial). Each workspace connects one CRM at a time. If your workspace moves to a plan without CRM sync, sync stops and nothing changes in either system; you can still see the connection, pause it or disconnect it, and it carries on where it left off when you upgrade.

## Connecting {#connecting}

Owners and admins open **Settings → Integrations** and press **Connect HubSpot** or **Connect Pipedrive**. You sign in to the CRM and approve the permissions Openline asks for: reading and writing contacts, companies and deals, and reading owners, pipelines and properties. Openline never asks for admin, email or settings access, and never creates properties, pipelines or stages in your CRM.

HubSpot also offers an optional permission to update subscriptions. Allow it so opt-outs reach HubSpot; without it, Integrations shows **"Opt-outs are not being sent to HubSpot"**.

Managers can see the connection's status and the sync log. Reps see the **Synced with HubSpot** badge on records.

## Setting it up {#setup}

1. **Pipeline and stages.** Pick the one CRM deal pipeline to sync. Deals in other pipelines are left alone. Map every CRM stage to an Openline stage and every Openline stage to a CRM stage; matching names are filled in for you. If a stage is added later on either side, deal sync waits and Integrations shows "Stage mapping needs attention" (contacts and companies keep syncing); update the mapping and the waiting deals sync. In Pipedrive, won and lost are deal statuses: Openline **Won** and **Lost** set the status, and a lost deal without a reason arrives as "Not given (from Pipedrive)".
2. **Fields.** Names, email, job title, phone, company, owner, deal name, amount, currency, stage, close date and lost reason are mapped for you. You can change each field's direction (both ways, to the CRM only, from the CRM only, or off) and add up to 20 custom field mappings per record type. Picklists and read-only CRM properties sync from the CRM only.
3. **Options.** Choose which new Openline contacts are created in the CRM (see below), whether to add activity notes, and the default owner.
4. **Preview.** **Run preview** shows what the import would do — records to create, to link to existing ones, to update, to skip (and why), and records only in Openline — without changing anything in either system.
5. **Import.** Confirm you have a lawful basis to contact the people you import (as for a CSV import) and press **Start import**. Imported contacts start with no consent basis recorded.

## How records are matched {#matching}

Contacts match by **email** and companies by **domain**, so linking never creates duplicates. Pipedrive organizations have no standard domain field: they match by the website field you map, otherwise by exact name, shown separately in the preview as "matched by name". Domains are compared without "www." and capital letters. If two companies would end up with the same domain, the domain isn't copied and the sync log shows "Domain already used by another company". Deals have no natural key: imported deals are created in Openline, and Openline-only deals are pushed; when importing again after forgetting links, a deal with exactly the same name in the pipeline (and the same amount and close date, where both have one) is linked instead of copied. CRM contacts without a valid email are skipped and counted. Suppressed addresses, including whole suppressed domains like @acme.com, are never imported or pushed.

## What syncs which way {#directions}

After the import, sync runs every 10 minutes (HubSpot) or 15 minutes (Pipedrive), sooner after a change in Openline, and less often when nothing changes. **Sync now** runs it straight away (up to 6 times an hour).

- New CRM contacts, companies and deals in the synced pipeline are created in Openline.
- Deals are always pushed to the CRM; companies when a synced contact or deal needs one.
- Contacts are pushed when they're **engaged** — on a deal, replied, or in a sequence — by default, because new HubSpot contacts can raise your HubSpot bill. You can choose **All contacts** or **Never** instead.
- **Activity notes** (off by default): a CRM note for each sent sequence email and each reply, with the subject only — never the email body.

Amounts are never converted between currencies. If the CRM can't hold a deal's currency, the amount isn't pushed, the deal shows "Currency not available in the CRM", and its other fields still sync.

## Conflicts and source of truth {#conflicts}

Openline remembers the value both systems last agreed on for each field. A field changed on one side is copied to the other. When the **same field** changed on both sides, the **newest change wins** (ties go to the CRM), and the decision is recorded in the sync log. To always prefer one side for a field, set **If both sides change** to **Openline wins** or **CRM wins** in the field mapping.

## Deletes, merges and erasure {#deletes}

Openline never deletes or merges anything in your CRM.

- A record deleted in the CRM stays in Openline, unlinked, with the badge **Deleted in HubSpot** (or Pipedrive). Restoring it in the CRM links it again.
- A record deleted or erased in Openline is not re-created by the next sync. If an erasure request covers both systems, **erase the person in your CRM too**.
- When the CRM merges two records, Openline re-links to the surviving one by email or domain. If two Openline records would point at one CRM record, the sync log shows a "Two Openline records point at one CRM record" error for an admin to resolve.

## Opt-outs {#opt-outs}

Opt-outs travel; re-subscribes never do. An unsubscribe or "asked not to contact" in Openline opts the person out in the CRM (HubSpot: unsubscribed from all email, with the optional permission; Pipedrive: marketing status unsubscribed, where Campaigns is on). An opt-out in the CRM adds a locked entry to your Openline suppression list (an existing unlocked entry for that address, such as a manual one, becomes locked) and marks the contact unsubscribed. Sync never re-subscribes anyone, removes a suppression or returns a contact to active. Your suppression list itself is never sent to the CRM.

## The sync log {#sync-log}

**Settings → Integrations → Sync log** lists every run and each record that couldn't sync, with links to the record in Openline and in the CRM. Errors retry after 5 minutes, 30 minutes and 2 hours, then wait for an admin to **Retry** or **Dismiss** them. Messages are written by Openline and never include your records' values.

## Pipedrive API budget {#pipedrive-budget}

Pipedrive gives each company one daily API budget shared by all its tools. Openline counts what it spends and stops for the day at a cap you set (15,000 tokens by default), showing "Paused until tomorrow: daily API budget". An idle connection uses roughly 1,500–3,000 tokens a day.

## Pausing {#pausing}

**Pause sync** stops both directions. Changes made while paused sync once when you press **Resume sync**.

## Disconnecting {#disconnecting}

**Disconnect** stops the sync, revokes Openline's access in the CRM and deletes the stored credentials. Nothing is deleted in either system. Openline keeps which records were linked (ids only), so reconnecting the **same** account carries on without duplicates; connecting a different account starts fresh. Choose **Disconnect and forget links** to clear the links as well; people erased in Openline stay erased and are never imported again.
`,
  },
];
