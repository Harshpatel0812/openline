terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Remote state in the bucket created by infra/terraform/bootstrap (S3 native locking).
  # Pass the bucket at init: terraform init -backend-config="bucket=<TF_STATE_BUCKET>" -backend-config="region=us-east-1"
  backend "s3" {
    key          = "openline/dev/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

variable "aws_region" {
  description = "AWS region (N. Virginia, chosen Nov 2026)."
  type        = string
  default     = "us-east-1"
}

variable "image_tag" {
  description = "Container image tag (commit SHA) to deploy."
  type        = string
  default     = ""
}

variable "env" {
  type    = string
  default = "dev"
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project = "openline"
      env     = var.env
    }
  }
}

# Modules are added in Week 0 / Sprint 1 (OL-E1):
# module "network" { source = "../../modules/network" ... }
# module "rds"     { source = "../../modules/rds" ... }
# module "redis"   { source = "../../modules/redis" ... }
# module "api"     { source = "../../modules/ecs-service" ... }
# module "worker"  { source = "../../modules/ecs-service" ... }
# module "web"     { source = "../../modules/ecs-service" ... }
