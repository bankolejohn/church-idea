###############################################
# AWS Secrets Manager Module
# Stores sensitive values:
# - DATABASE_URL
# - JWT_SECRET
###############################################

resource "aws_secretsmanager_secret" "database_url" {
  name        = "${var.project_name}/${var.environment}/database-url"
  description = "PostgreSQL connection string for ${var.environment}"

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = var.database_url
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name        = "${var.project_name}/${var.environment}/jwt-secret"
  description = "JWT signing secret for ${var.environment}"

  tags = {
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = var.jwt_secret
}
