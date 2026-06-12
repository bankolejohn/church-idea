variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "church-cms"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "container_image" {
  description = "Docker image to deploy (from GHCR or ECR)"
  type        = string
  default     = "ghcr.io/bankolejohn/church-idea:latest"
}

variable "db_name" {
  type    = string
  default = "churchdb"
}

variable "db_username" {
  type      = string
  sensitive = true
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "enable_nat_gateway" {
  description = "Enable NAT Gateway. Set to false for dev to save ~$32/month."
  type        = bool
  default     = false
}
