output "alb_dns_name" {
  description = "URL to access the application"
  value       = "http://${module.alb.alb_dns_name}"
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
