# Runbook: set up the AWS account (one time)

Owner: Harsh. Time: about 45 minutes. Region: **us-east-1 (N. Virginia)**.

Nobody on the build side ever needs your AWS password or keys. You do the steps that need your
login; GitHub Actions gets short-lived access through OIDC (no stored keys), and the app calls
Bedrock through a role. If anyone (person or tool) asks you for your AWS password, don't share it.

## 1. Lock down the root user (10 min)

The root user (the email you signed up with) can do anything, including close the account.

1. Sign in at <https://console.aws.amazon.com> as root.
2. Account menu (top right) → **Security credentials**:
   - **Update console password** to a new, unique password (a password manager helps).
   - **Assign MFA device** → Authenticator app → scan with Google Authenticator, Authy or
     1Password.
   - Under **Access keys**: there should be none. Never create one for root.
3. Account menu → **Account** → **Alternate contacts**: add your billing and security contact.

From now on use root only for billing and account settings.

## 2. Create your everyday admin login (10 min)

1. Console → search **IAM Identity Center** → **Enable** (in us-east-1).
2. **Users** → **Add user**: your name and email. Accept the email invitation, set a password, and
   register MFA when asked.
3. **Permission sets** → **Create** → Predefined → **AdministratorAccess**, session 8 hours.
4. **AWS accounts** → select your account → **Assign users or groups** → your user →
   AdministratorAccess.
5. Note the **AWS access portal URL** (Settings page). Bookmark it: this is how you sign in from now
   on.

## 3. Turn on billing alerts (2 min)

Console (as root) → **Billing and Cost Management** → **Billing preferences** → turn on **Receive
AWS Free Tier alerts** and **Receive CloudWatch billing alerts**. The bootstrap below also creates
a monthly budget alarm.

## 4. Install the tools on your PC (10 min)

In PowerShell:

```powershell
winget install -e --id Amazon.AWSCLI
winget install -e --id Hashicorp.Terraform
```

Close and reopen PowerShell, then sign in through Identity Center (no keys are stored):

```powershell
aws configure sso
#   SSO session name: openline
#   SSO start URL:    <your access portal URL from step 2>
#   SSO region:       us-east-1
#   (a browser window opens: approve)
#   Default region:   us-east-1
#   Profile name:     openline-admin
$env:AWS_PROFILE = "openline-admin"
aws sts get-caller-identity   # shows your account id and your user, not root
```

## 5. Run the bootstrap (5 min)

From your `openline` folder:

```powershell
git pull
cd infra\terraform\bootstrap
copy terraform.tfvars.example terraform.tfvars
notepad terraform.tfvars        # set billing_email
terraform init
terraform plan                  # read it: about 15 resources, all named openline-*
terraform apply                 # type yes
terraform output github_variables
```

It creates the Terraform state bucket, the GitHub OIDC trust, two deploy roles (staging and
production), the Bedrock policy and a monthly cost alarm. Keep the `terraform.tfstate` file in
that folder (it's git-ignored); don't delete it.

## 6. Connect GitHub (5 min)

In GitHub → the repository → **Settings**:

1. **Environments** → **New environment** `staging`. Then `production` → **Required reviewers** →
   add yourself (every production deploy waits for your approval).
2. **Secrets and variables** → **Actions** → **Variables** tab → add each value from
   `terraform output github_variables`: `AWS_REGION`, `AWS_STAGING_ROLE_ARN`, `AWS_PROD_ROLE_ARN`,
   `TF_STATE_BUCKET`, `BEDROCK_POLICY_ARN`. These are identifiers, not secrets.
3. Leave `DEPLOY_ENABLED` **unset** for now. Deploys switch on after the staging infrastructure
   (network, database, containers) is added in the infrastructure sprint.

## 7. Turn on Scout's AI models in Bedrock (3 min)

Console (your admin login), region **N. Virginia** → **Amazon Bedrock** → **Model access** →
**Modify model access** → select the models listed in `docs/adr/0005-scout-llm-provider.md` (one
small, one large) → submit the short use-case form. Approval usually takes minutes. You'll get an
email.

When it's approved, tell the team "Bedrock access approved". Don't send any keys or screenshots of
credentials. The model IDs go into the deployment configuration, not into chat.

## If something goes wrong

- `terraform apply` says the bucket name is taken: someone else owns that name; add a suffix in
  `main.tf` (`openline-terraform-state-<account>-2`).
- `aws` says the token expired: run `aws sso login --profile openline-admin`.
- You think a password or key leaked: change the password, check **CloudTrail → Event history** for
  activity you don't recognise, and remove any access key you didn't create.
