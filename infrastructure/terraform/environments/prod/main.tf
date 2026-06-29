###############################################
# Production Environment
# Full HA, Multi-AZ, encryption, monitoring
# Manual approval required for deployment
###############################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.30.0"
    }
  }

  # Remote state
  backend "s3" {
    bucket         = "church-cms-terraform-state-529088294210"
    key            = "prod/terraform.tfstate"
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
    }
  }
}

# ─────────────────────────────────────────────
# Networking
# ─────────────────────────────────────────────
module "vpc" {
  source = "../../modules/vpc"

  project_name       = var.project_name
  environment        = var.environment
  vpc_cidr           = "10.2.0.0/16"
  az_count           = 2  # Using 2 AZs (sufficient for HA, saves cost on NAT)
  enable_nat_gateway = true
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
# SSL Certificate (ACM)
# ─────────────────────────────────────────────
resource "aws_acm_certificate" "app" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  tags = {
    Name        = "${var.project_name}-${var.environment}-cert"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
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
  enable_https      = true
  certificate_arn   = aws_acm_certificate.app.arn
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
  task_subnet_ids       = module.vpc.private_subnet_ids
  assign_public_ip      = false
  alb_security_group_id = module.alb.alb_security_group_id
  target_group_arn      = module.alb.target_group_arn

  container_image = var.container_image
  container_port  = 3000
  cpu             = "512"
  memory          = "1024"
  desired_count   = 2
  max_count       = 6

  secrets_arns            = module.secrets.all_secret_arns
  database_url_secret_arn = module.secrets.database_url_arn
  jwt_secret_arn          = module.secrets.jwt_secret_arn

  enable_https       = true
  log_retention_days = 90
}

# ─────────────────────────────────────────────
# Database (RDS PostgreSQL - Multi-AZ)
# ─────────────────────────────────────────────
module "rds" {
  source = "../../modules/rds"

  project_name          = var.project_name
  environment           = var.environment
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  ecs_security_group_id = module.ecs.security_group_id

  instance_class        = "db.t3.small"
  allocated_storage     = 50
  max_allocated_storage = 200
  database_name         = var.db_name
  database_username     = var.db_username
  database_password     = var.db_password
  multi_az              = true
  backup_retention_days = 30
}
