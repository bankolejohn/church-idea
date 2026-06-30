output "zone_id" {
  description = "Route 53 hosted zone ID"
  value       = aws_route53_zone.main.zone_id
}

output "nameservers" {
  description = "Nameservers to configure in your domain registrar (Namecheap)"
  value       = aws_route53_zone.main.name_servers
}

output "certificate_arn" {
  description = "Validated ACM certificate ARN (ready to use on ALB)"
  value       = aws_acm_certificate_validation.app.certificate_arn
}

output "app_fqdn" {
  description = "Fully qualified domain name for the app"
  value       = var.app_subdomain != "" ? "${var.app_subdomain}.${var.domain_name}" : var.domain_name
}
