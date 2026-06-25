###############################################
# EKS Environment (Staging)
#
# This demonstrates the Kubernetes deployment path
# alongside the existing ECS path. In a real company,
# you'd choose ONE. Having both shows you can work
# with either and make informed trade-off decisions.
###############################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "church-cms-terraform-state-547624429131"
    key            = "eks/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "church-cms-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Platform    = "eks"
    }
  }
}

# ─────────────────────────────────────────────
# Networking (reuse VPC module)
# ─────────────────────────────────────────────
module "vpc" {
  source = "../../modules/vpc"

  project_name       = var.project_name
  environment        = var.environment
  vpc_cidr           = "10.3.0.0/16"  # Unique CIDR for EKS env
  az_count           = 2
  enable_nat_gateway = true  # Required for EKS nodes in private subnets
}

# ─────────────────────────────────────────────
# EKS Cluster
# ─────────────────────────────────────────────
module "eks" {
  source = "../../modules/eks"

  project_name       = var.project_name
  environment        = var.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids

  cluster_version        = "1.30"
  endpoint_public_access = true  # For dev/staging access

  # Managed node group (baseline capacity — Karpenter handles scaling)
  node_instance_types = ["t3.medium"]
  capacity_type       = "SPOT"  # Use Spot for staging (70% savings)
  node_desired_size   = 2
  node_min_size       = 1
  node_max_size       = 3
}

# ─────────────────────────────────────────────
# RDS PostgreSQL
# ─────────────────────────────────────────────
module "rds" {
  source = "../../modules/rds"

  project_name          = var.project_name
  environment           = var.environment
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  ecs_security_group_id = module.eks.cluster_security_group_id

  instance_class        = "db.t3.micro"
  allocated_storage     = 20
  max_allocated_storage = 50
  database_name         = var.db_name
  database_username     = var.db_username
  database_password     = var.db_password
  multi_az              = false
  backup_retention_days = 3
}

# ─────────────────────────────────────────────
# Secrets (for application)
# ─────────────────────────────────────────────
module "secrets" {
  source = "../../modules/secrets"

  project_name = var.project_name
  environment  = var.environment
  database_url = "postgresql://${var.db_username}:${var.db_password}@${module.rds.endpoint}/${var.db_name}"
  jwt_secret   = var.jwt_secret
}
