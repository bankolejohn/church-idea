###############################################
# Terraform Remote Backend Infrastructure
#
# This creates the S3 bucket and DynamoDB table
# used to store Terraform state for all environments.
#
# This module itself uses LOCAL state (chicken-and-egg).
# Once created, it never needs to be touched again.
#
# Usage:
#   cd infrastructure/terraform/backend
#   terraform init
#   terraform apply
###############################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "church-cms"
      ManagedBy = "terraform"
      Purpose   = "terraform-backend"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "church-cms"
}

# S3 Bucket for state files
resource "aws_s3_bucket" "terraform_state" {
  bucket = "${var.project_name}-terraform-state-${data.aws_caller_identity.current.account_id}"

  # Prevent accidental deletion
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name = "Terraform State"
  }
}

# Enable versioning (allows state recovery)
resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Encrypt state at rest
resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Block all public access
resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# DynamoDB table for state locking
resource "aws_dynamodb_table" "terraform_locks" {
  name         = "${var.project_name}-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name = "Terraform Lock Table"
  }
}

# Get current account ID
data "aws_caller_identity" "current" {}

# Outputs
output "state_bucket_name" {
  description = "S3 bucket name for Terraform state"
  value       = aws_s3_bucket.terraform_state.id
}

output "lock_table_name" {
  description = "DynamoDB table name for state locking"
  value       = aws_dynamodb_table.terraform_locks.id
}

output "backend_config" {
  description = "Backend configuration to use in environment files"
  value       = <<-EOT
    backend "s3" {
      bucket         = "${aws_s3_bucket.terraform_state.id}"
      region         = "${var.aws_region}"
      dynamodb_table = "${aws_dynamodb_table.terraform_locks.id}"
      encrypt        = true
      
      # Set key per environment:
      # key = "dev/terraform.tfstate"
      # key = "staging/terraform.tfstate"
      # key = "prod/terraform.tfstate"
    }
  EOT
}
