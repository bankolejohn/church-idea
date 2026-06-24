variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  type        = string
}

variable "ecs_service_name" {
  description = "Name of the ECS service"
  type        = string
}

variable "alb_arn_suffix" {
  description = "ARN suffix of the ALB (for CloudWatch alarm dimensions)"
  type        = string
}

variable "target_group_blue_name" {
  description = "Name of the blue (current production) target group"
  type        = string
}

variable "target_group_green_name" {
  description = "Name of the green (new version) target group"
  type        = string
}

variable "target_group_green_arn_suffix" {
  description = "ARN suffix of the green target group (for CloudWatch alarms)"
  type        = string
}

variable "listener_arns" {
  description = "ARN(s) of the production listener(s)"
  type        = list(string)
}

variable "test_listener_arn" {
  description = "ARN of the test traffic listener (optional, for pre-prod validation)"
  type        = string
  default     = ""
}

variable "deployment_config" {
  description = "CodeDeploy deployment configuration name"
  type        = string
  default     = "CodeDeployDefault.ECSCanary10Percent5Minutes"
  # Options:
  # - CodeDeployDefault.ECSAllAtOnce (instant — fast, risky)
  # - CodeDeployDefault.ECSLinear10PercentEvery1Minutes (gradual)
  # - CodeDeployDefault.ECSLinear10PercentEvery3Minutes (slower gradual)
  # - CodeDeployDefault.ECSCanary10Percent5Minutes (10% → wait 5min → 100%)
  # - CodeDeployDefault.ECSCanary10Percent15Minutes (10% → wait 15min → 100%)
}

variable "termination_wait_minutes" {
  description = "Minutes to wait before terminating old (blue) tasks after successful deploy"
  type        = number
  default     = 5
}

variable "auto_proceed" {
  description = "Automatically proceed with traffic shift (true) or wait for manual approval (false)"
  type        = bool
  default     = true
}

variable "manual_approval_wait_minutes" {
  description = "Minutes to wait for manual approval before timing out (only if auto_proceed=false)"
  type        = number
  default     = 60
}
