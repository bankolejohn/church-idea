variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "certificate_arn" {
  description = "ACM certificate ARN for HTTPS. If empty, only HTTP listener is created."
  type        = string
  default     = ""
}

variable "enable_https" {
  description = "Enable HTTPS listener (certificate_arn must also be provided)"
  type        = bool
  default     = false
}

variable "enable_blue_green" {
  description = "Create a second (green) target group for CodeDeploy blue/green deployments"
  type        = bool
  default     = false
}
