# Runbook: register the HubSpot and Pipedrive apps (one time)

Owner: Harsh. Time: about 1 hour 30 minutes. No coding needed. You need: a browser, the AWS access
portal login from `aws-setup.md`, and the web addresses of staging and production (for example
`https://staging.<your domain>` and `https://app.<your domain>`; below they are called
`<staging address>` and `<production address>`).

Why: CRM sync (Sprint 7, `docs/product/OL-E8-crm-sync.md`) asks a customer's HubSpot or Pipedrive
for permission through an "app" that Openline registers with each CRM. Each app has a **Client ID**
(not secret) and a **Client secret** (a password: it never goes into chat, email, tickets, code or
screenshots). You make **two apps per CRM**: one for staging (only test accounts can connect) and
one for production.

Until this is done, the Integrations page on staging and production shows "This CRM connection
isn't set up on this server yet". Nothing breaks.

## 1. HubSpot: developer account and test account (15 min)

1. Go to <https://developers.hubspot.com> → **Create a developer account** (free). Use your work
   email and turn on two-factor sign-in when asked.
2. In the developer account, open **Test accounts** (left menu) → **Create app test account**. Name
   it "Openline staging test". This is a free HubSpot account full of nothing; we connect staging to
   it, never to a real customer.
3. Open the test account. Click your account name (top right): the menu shows its **Hub ID** (a
   number). Write it down: it is not a secret.

## 2. HubSpot: the staging app (15 min)

1. Back in the developer account → **Apps** → **Create app**. Choose a **public app** (an app other
   HubSpot accounts can install; it stays unlisted until we apply to the marketplace).
2. **App info**: name "Openline (staging)", a short description ("Two-way sync between Openline and
   HubSpot"), our logo, and the support email.
3. **Auth** tab:
   - **Redirect URL**: `<staging address>/api/v1/integrations/crm/hubspot/callback` (exactly, no
     slash at the end).
   - **Scopes** → add these as **required**: `oauth`, `crm.objects.contacts.read`,
     `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.companies.write`,
     `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.objects.owners.read`,
     `crm.schemas.contacts.read`, `crm.schemas.companies.read`, `crm.schemas.deals.read`.
   - Add `communication_preferences.write` as **optional** (it lets Openline send opt-outs to
     HubSpot; customers may untick it).
   - Add nothing else. In particular no `automation`, `content`, email or webhook scopes.
4. **Save**. On the same tab you now see the **Client ID** and **Client secret**. Keep the tab open
   for step 6. Don't copy them anywhere else.

## 3. HubSpot: the production app (10 min)

Repeat section 2 with the name "Openline" and the redirect URL
`<production address>/api/v1/integrations/crm/hubspot/callback`. Keep that tab open too.

## 4. Pipedrive: developer sandbox (10 min)

1. Go to <https://developers.pipedrive.com> → **Join the Developer Hub** / **Get a sandbox
   account**. This gives you a free Pipedrive **sandbox company** with Developer Hub access. Turn on
   two-factor sign-in.
2. Sign in to the sandbox. Note its web address, for example `acme-sandbox.pipedrive.com`.
3. Find the sandbox's **company id** (a number, not a secret): while signed in, open
   `https://<your sandbox>.pipedrive.com/api/v1/users/me` in the same browser and look for
   `"company_id"`. If that page doesn't show it, send the engineer the sandbox's web address
   instead; they will read the id with you on a call. Never send a password or API token.

## 5. Pipedrive: the staging and production apps (20 min)

1. In the sandbox: **Settings** (your avatar, top right) → **Tools and apps** → **Developer Hub** →
   **Create an app** → **Create public app** (it stays unlisted until we publish it on the
   marketplace).
2. **Basic info**: name "Openline (staging)", short description, logo, support email.
3. **OAuth & access scopes**:
   - **Callback URL**: `<staging address>/api/v1/integrations/crm/pipedrive/callback`.
   - **Scopes**: tick **Contacts: Full access**, **Deals: Full access**, **Users: Read only**. Leave
     everything else off ("Base" is always included).
   - **App uninstallation callback URL**:
     `<staging address>/api/v1/integrations/crm/pipedrive/uninstall`. Pipedrive calls it when a
     customer removes the app; Openline then disconnects at once.
4. **Save**. The page shows the **Client ID** and **Client secret**. Keep the tab open.
5. Repeat steps 1–4 for production: name "Openline", and the same three addresses with
   `<production address>`.

## 6. Put the secrets into AWS Secrets Manager (15 min)

Do this in the browser, straight from the CRM tabs into AWS. Nothing goes through chat.

1. Sign in through your **AWS access portal URL** → the Openline account → **AdministratorAccess**
   → check the region (top right) says **N. Virginia (us-east-1)**.
2. Search **Secrets Manager** → **Store a new secret** → **Other type of secret**.
3. Add four **key / value** rows, copying each value from the staging tabs:

   | Key                           | Value from                           |
   | ----------------------------- | ------------------------------------ |
   | `CRM_HUBSPOT_CLIENT_ID`       | HubSpot staging app, Client ID       |
   | `CRM_HUBSPOT_CLIENT_SECRET`   | HubSpot staging app, Client secret   |
   | `CRM_PIPEDRIVE_CLIENT_ID`     | Pipedrive staging app, Client ID     |
   | `CRM_PIPEDRIVE_CLIENT_SECRET` | Pipedrive staging app, Client secret |

4. Encryption key: leave the default (`aws/secretsmanager`) → **Next**.
5. **Secret name**: `openline/staging/crm`. Description: "CRM app credentials (staging)". **Next**
   → leave rotation off → **Next** → **Store**.
6. Repeat 2–5 with the production values and the name `openline/production/crm`.
7. Close the CRM tabs. If a secret was ever pasted somewhere else by mistake, open the app in the
   CRM and **regenerate the client secret**, then update the AWS secret (Secrets Manager → the
   secret → **Retrieve secret value** → **Edit**).

## 7. Tell the engineer (5 min)

Send, in the ticket or chat, **only** these (none of them are secrets):

- "CRM secrets stored: `openline/staging/crm` and `openline/production/crm`."
- The HubSpot test account **Hub ID** (section 1) and the Pipedrive sandbox **company id**
  (section 4). They become `CRM_SANDBOX_ACCOUNT_IDS` on staging: staging refuses every other
  account, so a real customer's CRM can never be connected to staging.

The engineer then wires the secrets into the API and worker settings (staging uses
`CRM_MODE=sandbox`, production `CRM_MODE=live`) and runs the manual pre-release check against
your test accounts (PRD OL-E8, "Testing").

## 8. Check it works on staging (10 min)

1. Sign in to Openline staging as an owner → **Settings → Integrations** → **Connect HubSpot**.
2. HubSpot asks which account: choose **Openline staging test**. Check the permission list matches
   section 2, then **Connect app**. You land back on Integrations with "Connected to …".
3. Do the same with **Pipedrive** later (one CRM per workspace: disconnect HubSpot first, or use a
   second workspace).
4. If you see "Only sandbox CRM accounts can be connected on this server", the account id from
   section 7 is missing on staging: tell the engineer.

## Later: marketplace listings

Both apps stay unlisted: customers install them from the Integrations page. HubSpot limits
unlisted public apps to 25 installs, so we apply for the HubSpot marketplace before that (see the
"Decisions needed" section of `docs/sprints/S7.md`). Pipedrive listing is optional.
