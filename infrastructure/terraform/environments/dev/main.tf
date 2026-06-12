###############################################
# Dev Environment
# Minimal resources, cost-optimized
###############################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state - uncomment when S3 backend is created
  # backend "s3" {
  #   bucket         = "church-cms-terraform-state"
  #   key            = "dev/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ─────────────────────────────────────────────
# Networking
# ─────────────────────────────────────────────
module "vpc" {
  source = "../../modules/vpc"

  project_name = var.project_name
  environment  = var.environment
  vpc_cidr     = "10.0.0.0/16"
  az_count     = 2
}

# ─────────────────────────────────────────────
# Secrets
# ─────────────────────────────────────────────
module "secrets" {
  source = "../../modules/secrets"

  project_name = var.project_name
  environment  = var.environment
  database_url = "postgresql://${var.db_username}:${var.db_password}@${module.rds.endpoint}/${var.db_name}"
  jwt_secret   = var.jwt_secret
}

# ─────────────────────────────────────────────
# Load Balancer
# ─────────────────────────────────────────────
module "alb" {
  source = "../../modules/alb"

  project_name      = var.project_name
  environment       = var.environment
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  container_port    = 3000
}

# ─────────────────────────────────────────────
# Application (ECS Fargate)
# ─────────────────────────────────────────────
module "ecs" {
  source = "../../modules/ecs"

  project_name          = var.project_name
  environment           = var.environment
  aws_region            = var.aws_region
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  alb_security_group_id = module.alb.alb_security_group_id
  target_group_arn      = module.alb.target_group_arn

  container_image = var.container_image
  container_port  = 3000
  cpu             = "256"
  memory          = "512"
  desired_count   = 1
  max_count       = 2

  secrets_arns            = module.secrets.all_secret_arns
  database_url_secret_arn = module.secrets.database_url_arn
  jwt_secret_arn          = module.secrets.jwt_secret_arn

  log_retention_days = 7
}

# ─────────────────────────────────────────────
# Database (RDS PostgreSQL)
# ─────────────────────────────────────────────
module "rds" {
  source = "../../modules/rds"

  project_name          = var.project_name
  environment           = var.environment
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  ecs_security_group_id = module.ecs.security_group_id

  instance_class        = "db.t3.micro"
  allocated_storage     = 20
  max_allocated_storage = 50
  database_name         = var.db_name
  database_username     = var.db_username
  database_password     = var.db_password
  multi_az              = false
  backup_retention_days = 3
}
