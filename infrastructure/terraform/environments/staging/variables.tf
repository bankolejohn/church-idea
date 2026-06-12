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
  default = "staging"
}

variable "container_image" {
  description = "Docker image to deploy"
  type        = string
  default     = "ghcr.io/bankolejohn/church-idea:develop"
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
