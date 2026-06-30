###############################################
# Route 53 DNS Module
#
# WHAT THIS DOES:
# Manages ALL DNS in Terraform — no more manual
# clicking in Namecheap for every deployment.
#
# ONE-TIME SETUP:
# 1. This module creates a Route 53 hosted zone
# 2. You copy the 4 NS (nameserver) records to Namecheap
# 3. After that, ALL DNS changes happen in Terraform
#
# WHAT IT AUTOMATES:
# - ACM certificate DNS validation (instant, no waiting)
# - Domain → ALB routing (A record alias)
# - Any future subdomains (staging.x.com, api.x.com)
#
# COST: $0.50/month per hosted zone + $0.40 per million queries
###############################################

# ─── Hosted Zone ──────────────────────────────────────────────────
resource "aws_route53_zone" "main" {
  name    = var.domain_name
  comment = "Managed by Terraform — ${var.project_name}"

  tags = {
    Name        = var.domain_name
    Project     = var.project_name
    ManagedBy   = "terraform"
  }
}

# ─── ACM Certificate ──────────────────────────────────────────────
resource "aws_acm_certificate" "app" {
  domain_name               = var.app_subdomain != "" ? "${var.app_subdomain}.${var.domain_name}" : var.domain_name
  subject_alternative_names = var.additional_domains
  validation_method         = "DNS"

  tags = {
    Name        = "${var.project_name}-${var.environment}-cert"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ─── DNS Validation Records (AUTOMATIC) ──────────────────────────
# This is the magic — Route 53 creates the validation CNAME automatically
# No more manual clicking in Namecheap!
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.app.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id = aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  allow_overwrite = true
}

# ─── Certificate Validation Waiter ────────────────────────────────
# Terraform waits until ACM confirms the cert is validated
# This means: one `terraform apply` does EVERYTHING (no partial failure)
resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# ─── App Domain → ALB (A Record Alias) ───────────────────────────
# Points your domain to the load balancer
# Uses an ALIAS record (not CNAME) — works on zone apex and is free
resource "aws_route53_record" "app" {
  count   = var.alb_dns_name != "" ? 1 : 0
  zone_id = aws_route53_zone.main.zone_id
  name    = var.app_subdomain != "" ? "${var.app_subdomain}.${var.domain_name}" : var.domain_name
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}
