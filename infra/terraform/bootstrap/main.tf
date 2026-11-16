# One-time account bootstrap for Openline (run by Harsh, signed in with his own admin user + MFA).
# Creates: the Terraform state bucket, GitHub's OIDC identity provider, the deploy roles GitHub
# Actions assumes (no long-lived keys anywhere), a policy that lets the app call Bedrock, and a
# monthly cost alarm. See docs/runbooks/aws-setup.md.
#
# State for this bootstrap stays local (terraform.tfstate in this folder, git-ignored): it only
# describes these few resources. Keep the file safe; it can be re-created with `terraform import`.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }
}

variable "aws_region" {
  description = "Primary region (N. Virginia, chosen Nov 2026)."
  type        = string
  default     = "us-east-1"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy."
  type        = string
  default     = "Harshpatel0812/openline"
}

variable "billing_email" {
  description = "Where the monthly cost alarm is emailed."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Alarm when forecast or actual monthly spend passes this."
  type        = number
  default     = 100
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project    = "openline"
      managed-by = "terraform-bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  state_bucket = "openline-terraform-state-${local.account_id}"
}

# --- Terraform state (used by envs/staging and envs/prod) -------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "state_tls_only" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# --- GitHub Actions → AWS without stored keys (OIDC) ------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Each role can only be assumed by a workflow job running in the matching GitHub environment of
# this repository (staging, or production, which requires Harsh's approval in GitHub).
data "aws_iam_policy_document" "deploy_trust" {
  for_each = toset(["staging", "production"])

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${each.key}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  for_each             = data.aws_iam_policy_document.deploy_trust
  name                 = "openline-github-deploy-${each.key}"
  path                 = "/openline/"
  assume_role_policy   = each.value.json
  max_session_duration = 3600
}

# Deploys create ECS, RDS, VPC, ECR, etc. PowerUserAccess covers those but not IAM; IAM is
# limited to roles and policies under the /openline/ path, so a deploy can't touch anything else.
resource "aws_iam_role_policy_attachment" "deploy_power_user" {
  for_each   = aws_iam_role.deploy
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "deploy_iam_scoped" {
  statement {
    sid = "ManageOpenlineRolesOnly"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:TagRole",
      "iam:UntagRole", "iam:PassRole", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
      "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
      "iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy", "iam:GetPolicyVersion",
      "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:ListPolicyVersions",
      "iam:TagPolicy", "iam:UntagPolicy",
    ]
    resources = [
      "arn:aws:iam::${local.account_id}:role/openline/*",
      "arn:aws:iam::${local.account_id}:policy/openline/*",
    ]
  }

  statement {
    sid       = "ServiceLinkedRolesForManagedServices"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/aws-service-role/*"]
  }

  statement {
    sid       = "TerraformState"
    actions   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
  }
}

resource "aws_iam_role_policy" "deploy_iam_scoped" {
  for_each = aws_iam_role.deploy
  name     = "openline-scoped-iam-and-state"
  role     = each.value.id
  policy   = data.aws_iam_policy_document.deploy_iam_scoped.json
}

# --- Scout: calling AI models on Bedrock --------------------------------------------------------
# Attached later to the API and worker task roles (envs/*). Invoke only; no model management.

data "aws_iam_policy_document" "bedrock_invoke" {
  statement {
    sid     = "InvokeFoundationModels"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:${var.aws_region}:${local.account_id}:inference-profile/*",
    ]
  }
}

resource "aws_iam_policy" "bedrock_invoke" {
  name        = "openline-bedrock-invoke"
  path        = "/openline/"
  description = "Lets Openline's API and worker call Bedrock models (Scout)."
  policy      = data.aws_iam_policy_document.bedrock_invoke.json
}

# --- Cost alarm -------------------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "openline-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.billing_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.billing_email]
  }
}

# --- What to copy into GitHub (Settings → Secrets and variables → Actions → Variables) ---------

output "github_variables" {
  description = "Repository variables to set in GitHub (none of these are secrets)."
  value = {
    AWS_REGION           = var.aws_region
    AWS_STAGING_ROLE_ARN = aws_iam_role.deploy["staging"].arn
    AWS_PROD_ROLE_ARN    = aws_iam_role.deploy["production"].arn
    TF_STATE_BUCKET      = aws_s3_bucket.state.bucket
    BEDROCK_POLICY_ARN   = aws_iam_policy.bedrock_invoke.arn
  }
}
