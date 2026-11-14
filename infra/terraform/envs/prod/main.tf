terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Remote state. Bucket and lock table are created once by hand (bootstrap) per account.
  backend "s3" {
    key          = "openline/prod/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

variable "aws_region" {
  description = "AWS region for this environment (decision pending)."
  type        = string
}

variable "image_tag" {
  description = "Container image tag (commit SHA) to deploy."
  type        = string
  default     = ""
}

variable "env" {
  type    = string
  default = "prod"
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
