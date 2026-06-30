variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "domain_name" {
  description = "Root domain (e.g., johndesiventures.website)"
  type        = string
}

variable "app_subdomain" {
  description = "Subdomain for the app (e.g., 'app' → app.johndesiventures.website). Empty string = zone apex."
  type        = string
  default     = ""
}

variable "additional_domains" {
  description = "Additional domains for the certificate (SANs)"
  type        = list(string)
  default     = []
}

variable "alb_dns_name" {
  description = "ALB DNS name to point the domain to. Empty = skip A record creation."
  type        = string
  default     = ""
}

variable "alb_zone_id" {
  description = "ALB hosted zone ID (for alias record)"
  type        = string
  default     = ""
}
