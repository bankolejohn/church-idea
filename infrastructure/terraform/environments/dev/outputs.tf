output "alb_dns_name" {
  description = "URL to access the application"
  value       = "https://${var.domain_name}"
}

output "alb_raw_dns" {
  description = "ALB DNS name (for CNAME record)"
  value       = module.alb.alb_dns_name
}

output "certificate_validation" {
  description = "DNS records to add on Namecheap for certificate validation"
  value = {
    for dvo in aws_acm_certificate.app.domain_validation_options : dvo.domain_name => {
      type  = dvo.resource_record_type
      name  = dvo.resource_record_name
      value = dvo.resource_record_value
    }
  }
}

output "ecs_cluster" {
  value = module.ecs.cluster_name
}

output "ecs_service" {
  value = module.ecs.service_name
}

output "rds_endpoint" {
  value     = module.rds.endpoint
  sensitive = true
}
