output "database_url_arn" {
  value = aws_secretsmanager_secret.database_url.arn
}

output "jwt_secret_arn" {
  value = aws_secretsmanager_secret.jwt_secret.arn
}

output "all_secret_arns" {
  description = "All secret ARNs (for IAM policy)"
  value = [
    aws_secretsmanager_secret.database_url.arn,
    aws_secretsmanager_secret.jwt_secret.arn
  ]
}
