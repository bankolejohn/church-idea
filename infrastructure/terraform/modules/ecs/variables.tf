variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "target_group_arn" {
  type = string
}

variable "container_image" {
  description = "Docker image to deploy"
  type        = string
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "cpu" {
  description = "Fargate task CPU units (256, 512, 1024, 2048, 4096)"
  type        = string
  default     = "256"
}

variable "memory" {
  description = "Fargate task memory in MB (512, 1024, 2048, ...)"
  type        = string
  default     = "512"
}

variable "desired_count" {
  description = "Number of tasks to run"
  type        = number
  default     = 2
}

variable "max_count" {
  description = "Maximum number of tasks for auto-scaling"
  type        = number
  default     = 4
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "secrets_arns" {
  description = "List of Secrets Manager ARNs the task can read"
  type        = list(string)
}

variable "database_url_secret_arn" {
  description = "ARN of the DATABASE_URL secret"
  type        = string
}

variable "jwt_secret_arn" {
  description = "ARN of the JWT_SECRET secret"
  type        = string
}
