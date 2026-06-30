# Runbook: Disaster Recovery

**Scenario:** Complete environment failure. Need to recreate everything from scratch.
**RTO (Recovery Time Objective):** < 30 minutes
**RPO (Recovery Point Objective):** < 1 hour (RDS backup frequency)

---

## When to Use This Runbook

- AWS region failure (entire us-east-1 is down)
- Terraform state corrupted beyond repair
- Accidental `terraform destroy` on production
- Security breach requiring full infrastructure rebuild
- Migration to a new AWS account

---

## Prerequisites

You need:
- [ ] AWS CLI configured with appropriate credentials
- [ ] Terraform installed with provider cached locally
- [ ] Access to the Git repository (all infra is in code)
- [ ] DNS registrar access (Namecheap)
- [ ] The `terraform.tfvars` values (from password manager)

---

## Recovery Steps

### Step 1: Recreate the Backend (if destroyed)

```bash
cd infrastructure/terraform/backend
terraform init -plugin-dir=/Users/YOUR_USER/.terraform.d/plugins
terraform apply -auto-approve
# Creates: S3 bucket + DynamoDB table (~30 seconds)
```

### Step 2: Recreate Production Infrastructure

```bash
cd infrastructure/terraform/environments/prod

# Recreate tfvars (from password manager backup)
cat > terraform.tfvars << EOF
db_username = "churchadmin"
db_password = "YOUR_BACKED_UP_PASSWORD"
jwt_secret  = "YOUR_BACKED_UP_JWT_SECRET"
EOF

terraform init -plugin-dir=/Users/YOUR_USER/.terraform.d/plugins
terraform apply
# Takes ~10 minutes
# First run partially fails (ACM cert validation)
```

### Step 3: Validate ACM Certificate

```bash
terraform output certificate_validation
# Add the CNAME record in Namecheap
# Wait 2-5 minutes
terraform apply
# Completes the HTTPS listener + ECS service
```

### Step 4: Restore Database

**Option A: From RDS automated backup (point-in-time recovery)**
```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier church-cms-prod-db \
  --target-db-instance-identifier church-cms-prod-db-restored \
  --restore-time "2026-06-29T12:00:00Z" \
  --db-instance-class db.t3.small \
  --no-multi-az
```

**Option B: Fresh database (if no backup exists)**
```bash
# Run migrations + seed
SUBNET=$(aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=church-cms-prod-private-1" \
  --query 'Subnets[0].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=church-cms-prod-ecs-sg" \
  --query 'SecurityGroups[0].GroupId' --output text)

aws ecs run-task \
  --cluster church-cms-prod-cluster \
  --task-definition church-cms-prod \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"church-cms-app","command":["sh","-c","node db/migrate.js && node db/seed.js"]}]}'
```

### Step 5: Update DNS

```bash
# Get new ALB DNS
terraform output alb_raw_dns

# Update in Namecheap:
# Type: CNAME | Host: app | Target: new-alb-dns.us-east-1.elb.amazonaws.com
```

### Step 6: Verify

```bash
curl -s https://app.johndesiventures.website/health
curl -s https://app.johndesiventures.website/ready
curl -s -X POST https://app.johndesiventures.website/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

---

## Recovery Timeline

| Step | Time | Cumulative |
|------|------|-----------|
| Backend creation | 30s | 0:30 |
| Terraform apply (first) | 10 min | 10:30 |
| ACM validation + DNS | 5 min | 15:30 |
| Terraform apply (second) | 2 min | 17:30 |
| Database restore/migrate | 5 min | 22:30 |
| DNS update + propagation | 5 min | 27:30 |
| Verification | 2 min | **29:30** |

**Total: ~30 minutes** from zero to fully operational.

---

## What Can't Be Recovered

| Data | Recoverable? | How |
|------|-------------|-----|
| Application code | Yes | Git repository |
| Infrastructure | Yes | Terraform code |
| Database data | Yes (up to 1h ago) | RDS automated backups (30-day retention) |
| Secrets (passwords) | Only if backed up | Password manager |
| CloudWatch logs | No (if region failed) | Gone — accept the loss |
| Terraform state | Yes | S3 versioning (restore previous version) |

---

## Prevention

- [ ] Store `terraform.tfvars` values in a password manager (1Password, Bitwarden)
- [ ] Verify RDS backups are completing daily (check CloudWatch)
- [ ] Run this DR drill quarterly (time yourself — target < 30 min)
- [ ] Consider cross-region RDS replica for < 5 min RPO

---
