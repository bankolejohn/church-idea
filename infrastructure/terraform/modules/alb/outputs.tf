output "alb_arn" {
  value = aws_lb.main.arn
}

output "alb_arn_suffix" {
  description = "ARN suffix for CloudWatch alarm dimensions"
  value       = aws_lb.main.arn_suffix
}

output "alb_dns_name" {
  description = "DNS name of the load balancer"
  value       = aws_lb.main.dns_name
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "target_group_arn" {
  value = aws_lb_target_group.app.arn
}

output "target_group_name" {
  description = "Blue target group name (for CodeDeploy)"
  value       = aws_lb_target_group.app.name
}

output "target_group_green_arn" {
  description = "Green target group ARN (for CodeDeploy blue/green)"
  value       = var.enable_blue_green ? aws_lb_target_group.app_green[0].arn : ""
}

output "target_group_green_name" {
  description = "Green target group name (for CodeDeploy)"
  value       = var.enable_blue_green ? aws_lb_target_group.app_green[0].name : ""
}

output "target_group_green_arn_suffix" {
  description = "Green target group ARN suffix (for CloudWatch alarms)"
  value       = var.enable_blue_green ? aws_lb_target_group.app_green[0].arn_suffix : ""
}

output "listener_arn" {
  description = "Production listener ARN (HTTPS if enabled, otherwise HTTP)"
  value       = var.enable_https ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
}
