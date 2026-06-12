output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "security_group_id" {
  description = "ECS task security group ID (used by RDS to allow inbound)"
  value       = aws_security_group.ecs.id
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.app.arn
}
