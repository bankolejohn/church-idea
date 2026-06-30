# Route 53 DNS Integration — Fully Automated HTTPS

This guide explains how to use Route 53 to eliminate ALL manual DNS steps from deployments.

---

## The Problem (Before Route 53)

Every time you deploy with `terraform apply`:
1. Terraform creates an ACM certificate
2. You manually log into Namecheap
3. Copy the validation CNAME record
4. Wait 2-5 minutes for validation
5. Run `terraform apply` AGAIN (second pass)
6. Manually add another CNAME for the ALB
7. Wait for DNS propagation

**This process breaks automation.** CI/CD can't do step 2-3 (it requires a human clicking in a UI).

---

## The Solution (Route 53)

Move DNS management from Namecheap to AWS Route 53. Then Terraform controls everything:

```
terraform apply (ONE COMMAND):
  → Creates Route 53 hosted zone
  → Creates ACM certificate
  → Automatically adds DNS validation record
  → Waits for validation (30 seconds, not 5 minutes)
  → Creates HTTPS listener with validated cert
  → Points domain to ALB via A record alias
  → DONE — no manual steps, no second apply
```

---

## One-Time Setup (5 Minutes)

### Step 1: Deploy the DNS module

```bash
# Add the dns module to your environment config (see example below)
# Then:
terraform init
terraform apply
```

### Step 2: Get the nameservers

```bash
terraform output nameservers
# Output:
# [
#   "ns-1234.awsdns-12.org",
#   "ns-567.awsdns-34.net",
#   "ns-890.awsdns-56.co.uk",
#   "ns-111.awsdns-78.com"
# ]
```

### Step 3: Configure Namecheap (one-time, never again)

1. Go to Namecheap → Domain List → `johndesiventures.website` → Manage
2. Under "Nameservers" → select "Custom DNS"
3. Add all 4 nameservers from Step 2
4. Save

**After this, Namecheap is only the REGISTRAR (owns the domain name). Route 53 handles ALL DNS resolution.**

---

## How to Use in an Environment

```hcl
# In environments/prod/main.tf:

module "dns" {
  source = "../../modules/dns"

  project_name  = var.project_name
  environment   = var.environment
  domain_name   = "johndesiventures.website"
  app_subdomain = "app"  # → app.johndesiventures.website
  alb_dns_name  = module.alb.alb_dns_name
  alb_zone_id   = module.alb.alb_zone_id
}

# Use the validated certificate on the ALB
module "alb" {
  source = "../../modules/alb"
  ...
  certificate_arn = module.dns.certificate_arn
  enable_https    = true
}
```

---

## What Changes (Before vs After)

| Step | Before (Manual) | After (Route 53) |
|------|----------------|-------------------|
| ACM validation | Manual CNAME in Namecheap, wait 5 min | Automatic, 30 seconds |
| Domain → ALB | Manual CNAME in Namecheap | Terraform A record alias |
| New subdomain | Manual | One line in Terraform |
| Deploy staging | 2 applies + manual DNS | Single `terraform apply` |
| Deploy production | 2 applies + manual DNS | Single `terraform apply` |
| Teardown + redeploy | Update DNS twice | Automatic (DNS stays in Route 53) |

---

## Cost

| Item | Cost |
|------|------|
| Hosted zone | $0.50/month |
| DNS queries | $0.40 per million queries (first billion free) |
| **Total** | ~$0.50/month |

---

## Module Outputs

| Output | Usage |
|--------|-------|
| `nameservers` | Copy to Namecheap (one-time) |
| `certificate_arn` | Pass to ALB module for HTTPS |
| `zone_id` | Use for additional records |
| `app_fqdn` | The full domain name |

---

## Key Concepts

**Hosted Zone:** A container for DNS records for a specific domain. Route 53 creates 4 nameservers for it.

**Alias Record:** Like a CNAME but works on the zone apex (bare domain) and is free (no query charges). Always use alias for AWS resources (ALB, CloudFront, S3).

**ACM Validation:** Route 53 can create the validation CNAME instantly (same AWS account). No cross-provider delay.

**`aws_acm_certificate_validation`:** A Terraform resource that WAITS until the certificate is validated. This means `terraform apply` blocks until HTTPS is ready — no partial failures.

---

## For Interviews

"I moved DNS management from a manual registrar (Namecheap) to Route 53 managed by Terraform. This eliminated all manual DNS steps from deployments — ACM certificate validation, domain routing, and subdomain creation are now fully automated. A single `terraform apply` goes from zero to a working HTTPS endpoint without any human intervention."
