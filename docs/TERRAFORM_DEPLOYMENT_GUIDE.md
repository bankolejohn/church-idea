# Terraform Deployment Guide — Step by Step

This guide walks you through deploying the Church CMS to AWS from scratch using Terraform. Every command, every decision, every gotcha — documented for anyone to follow.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Create the Remote Backend](#step-1-create-the-remote-backend)
3. [Step 2: Initialize the Dev Environment](#step-2-initialize-the-dev-environment)
4. [Step 3: Deploy Infrastructure](#step-3-deploy-infrastructure)
5. [Step 4: Validate the ACM Certificate (DNS)](#step-4-validate-the-acm-certificate-dns)
6. [Step 5: Complete the Deployment](#step-5-complete-the-deployment)
7. [Step 6: Run Database Migrations](#step-6-run-database-migrations)
8. [Step 7: Configure Domain DNS](#step-7-configure-domain-dns)
9. [Step 8: Verify Everything Works](#step-8-verify-everything-works)
10. [What NOT to Commit](#what-not-to-commit)
11. [Tearing Down (Stop All Charges)](#tearing-down-stop-all-charges)
12. [Common Errors and Fixes](#common-errors-and-fixes)
13. [Cost Breakdown](#cost-breakdown)

---

## Prerequisites

Before you start, you need:

| Tool | Install Command | Verify |
|------|----------------|--------|
| AWS CLI | `brew install awscli` | `aws --version` |
| Terraform | `brew install terraform` | `terraform version` |
| AWS Account | [aws.amazon.com](https://aws.amazon.com) | `aws sts get-caller-identity` |
| Domain | Any registrar (Namecheap, Route53, etc.) | — |
| Docker image pushed to GHCR | CI pipeline does this on merge to main | — |

**Configure AWS CLI:**
```bash
aws configure
# AWS Access Key ID: (your key)
# AWS Secret Access Key: (your secret)
# Default region: us-east-1
# Output format: json
```

---

## Step 1: Create the Remote Backend

**What:** An S3 bucket + DynamoDB table that stores Terraform state.
**Why:** Without this, Terraform state is LOCAL — if your laptop dies, you lose track of all deployed resources.
**One-time setup:** You only do this once, ever.

```bash
cd infrastructure/terraform/backend
terraform init
terraform apply -auto-approve
```

This creates:
- S3 bucket: `church-cms-terraform-state-{account_id}` (versioned, encrypted)
- DynamoDB table: `church-cms-terraform-locks` (prevents concurrent writes)

**Output:** Note the bucket name — you'll need it in the next step.

---

## Step 2: Initialize the Dev Environment

**What:** Downloads the AWS provider and configures the S3 backend.
**Why:** Terraform needs the AWS provider plugin to talk to AWS.

### If Terraform Init Fails (Provider Download Issue)

The AWS provider is ~250-400MB. If your connection is slow:

```bash
# 1. Download manually via browser:
# https://releases.hashicorp.com/terraform-provider-aws/5.31.0/terraform-provider-aws_5.31.0_darwin_amd64.zip

# 2. Create the filesystem mirror:
mkdir -p ~/.terraform.d/plugins/registry.terraform.io/hashicorp/aws/5.31.0/darwin_amd64
unzip /tmp/terraform-provider-aws.zip \
  -d ~/.terraform.d/plugins/registry.terraform.io/hashicorp/aws/5.31.0/darwin_amd64/
chmod +x ~/.terraform.d/plugins/registry.terraform.io/hashicorp/aws/5.31.0/darwin_amd64/terraform-provider-aws_*

# 3. Init with filesystem mirror (USE ABSOLUTE PATH — not ~)
cd infrastructure/terraform/environments/dev
terraform init -plugin-dir=/Users/YOUR_USERNAME/.terraform.d/plugins
```

**CRITICAL:** Use the absolute path, not `~`. The tilde doesn't expand in flag arguments.

### If Init Works Normally

```bash
cd infrastructure/terraform/environments/dev
terraform init
```

---

## Step 3: Deploy Infrastructure

### Create terraform.tfvars (secrets file)

```bash
cat > terraform.tfvars << EOF
db_username = "churchadmin"
db_password = "$(openssl rand -base64 24)"
jwt_secret  = "$(openssl rand -hex 32)"
EOF
```

**NEVER commit this file.** It contains database credentials. It's already in `.gitignore`.

### Preview Changes

```bash
terraform plan
# Shows: Plan: 37 to add, 0 to change, 0 to destroy.
```

### Apply

```bash
terraform apply
# Type 'yes' when prompted
# Takes 7-10 minutes (RDS is slowest)
```

**Expected outcome:** Partial success on first run. The HTTPS listener and ECS service will fail because the ACM certificate isn't validated yet. This is normal — proceed to Step 4.

---

## Step 4: Validate the ACM Certificate (DNS)

**What:** AWS needs proof you own the domain before issuing an SSL certificate.
**How:** Add a CNAME record to your DNS provider.

```bash
terraform output certificate_validation
```

Output:
```
"churchidea.johndesiventures.website" = {
  "name"  = "_xxxxx.churchidea.johndesiventures.website."
  "type"  = "CNAME"
  "value" = "_yyyyy.acm-validations.aws."
}
```

**In your DNS provider (e.g., Namecheap):**

| Type | Host | Target |
|------|------|--------|
| CNAME | `_xxxxx.churchidea` | `_yyyyy.acm-validations.aws.` |

**Important:** Your DNS provider auto-appends the domain. So the Host field is just the prefix WITHOUT `.johndesiventures.website`.

**Verify validation (wait 2-5 minutes):**
```bash
aws acm describe-certificate \
  --certificate-arn $(terraform output -raw certificate_arn 2>/dev/null || aws acm list-certificates --query 'CertificateSummaryList[0].CertificateArn' --output text) \
  --query 'Certificate.Status' --output text
# Should return: ISSUED
```

---

## Step 5: Complete the Deployment

Once the certificate shows `ISSUED`:

```bash
terraform apply
# Type 'yes'
# This time: creates HTTPS listener + ECS service (the 2 that failed before)
```

**Expected:** `Apply complete! Resources: 2 added, 0 changed, 0 destroyed.`

---

## Step 6: Run Database Migrations

**What:** Creates tables in the PostgreSQL database and seeds the admin user.
**Why:** The app container connects to an EMPTY database — no tables exist until you migrate.
**How:** Run a one-off ECS task that executes `node db/migrate.js && node db/seed.js`.

```bash
# Get network config (subnet + security group)
SUBNET=$(aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=church-cms-dev-public-1" \
  --query 'Subnets[0].SubnetId' --output text)

SG=$(aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=church-cms-dev-ecs-sg" \
  --query 'SecurityGroups[0].GroupId' --output text)

# Run migrations
aws ecs run-task \
  --cluster church-cms-dev-cluster \
  --task-definition church-cms-dev \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"church-cms-app","command":["sh","-c","node db/migrate.js && node db/seed.js"]}]}'
```

**Verify migrations ran:**
```bash
aws logs tail /ecs/church-cms-dev --since 5m
# Should show: "Running migration: 001_create_tables"
#              "All migrations complete."
#              "Admin user created successfully"
```

---

## Step 7: Configure Domain DNS

**What:** Point your domain to the ALB so users can access the app.

```bash
# Get ALB DNS name
terraform output alb_raw_dns
# or: aws elbv2 describe-load-balancers --names church-cms-dev-alb --query 'LoadBalancers[0].DNSName' --output text
```

**In your DNS provider:**

| Type | Host | Target |
|------|------|--------|
| CNAME | `churchidea` | `church-cms-dev-alb-XXXXXXX.us-east-1.elb.amazonaws.com` |

Wait 2-5 minutes for DNS propagation.

---

## Step 8: Verify Everything Works

```bash
# Health check
curl -s https://churchidea.johndesiventures.website/health
# {"status":"ok","timestamp":"...","uptime":...}

# Database connectivity
curl -s https://churchidea.johndesiventures.website/ready
# {"status":"ready","database":"connected"}

# Login
curl -s -X POST https://churchidea.johndesiventures.website/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# {"token":"eyJ...","user":{"id":1,"username":"admin","role":"main_leader"}}
```

If all three return success — **you're deployed.**

Open `https://churchidea.johndesiventures.website` in your browser and log in.

---

## What NOT to Commit

These files contain secrets and must NEVER be in git:

| File | Contains | In .gitignore? |
|------|----------|---------------|
| `terraform.tfvars` | Database password, JWT secret | Yes |
| `.terraform/` | Provider binaries (huge) | Yes |
| `*.tfstate` | Resource IDs, can contain secrets | Yes (state is in S3) |
| `.env` | Local environment secrets | Yes |

**If you accidentally commit secrets:** Rotate them immediately. Git history is permanent — even after deleting the file.

---

## Tearing Down (Stop All Charges)

```bash
cd infrastructure/terraform/environments/dev
terraform destroy
# Type 'yes'
# Removes ALL 37 resources. Takes ~5 minutes.
```

**After destroy, also remove DNS records** in Namecheap (they'll point to nothing).

**Cost if you forget:** ~$41/month running, $0 after destroy.

---

## Common Errors and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `UnsupportedCertificate` on HTTPS listener | ACM cert not validated (DNS record missing/wrong) | Add correct CNAME, wait, re-apply |
| `target group does not have an associated load balancer` | HTTPS listener failed → target group never attached | Fix cert validation, re-apply |
| `ResourceNotFoundException: secret not found` | Secrets Manager entry pending (race condition) | `aws ecs update-service --force-new-deployment` |
| Login page loads but login fails | Database has no tables (migrations not run) | Run the migration ECS task (Step 6) |
| `Could not resolve host` for custom domain | DNS CNAME not added for the domain | Add CNAME pointing to ALB DNS |
| `terraform init` download fails | AWS provider too large for connection | Manual download + filesystem mirror |
| `~/.terraform.d/plugins: no such file` | Tilde not expanded in flag args | Use absolute path: `/Users/you/.terraform.d/plugins` |

---

## Cost Breakdown (Dev Environment)

| Service | Monthly Cost | What It Is |
|---------|-------------|-----------|
| ECS Fargate (1 task, 0.25 vCPU, 512MB) | ~$9 | Your app container |
| RDS db.t3.micro (PostgreSQL) | ~$15 | Database |
| ALB | ~$16 | Load balancer + data transfer |
| Secrets Manager (2 secrets) | ~$1 | DATABASE_URL + JWT_SECRET |
| CloudWatch Logs | < $1 | Log storage |
| S3 + DynamoDB (Terraform state) | < $1 | State storage + locking |
| NAT Gateway | $0 | Disabled in dev (saves $32) |
| **Total** | **~$41/month** | |

**To reduce costs when not actively using:**
```bash
# Scale to 0 tasks (keeps infra, stops compute charges ~$9)
aws ecs update-service --cluster church-cms-dev-cluster \
  --service church-cms-dev-service --desired-count 0

# Scale back up when needed
aws ecs update-service --cluster church-cms-dev-cluster \
  --service church-cms-dev-service --desired-count 1
```

---

## The Complete Timeline (What We Did)

```
1. Created S3 backend (terraform state storage)                    → 30 seconds
2. terraform init (downloaded AWS provider — troubleshooting)      → 30 minutes (network issues)
3. terraform plan (previewed 37 resources)                         → 10 seconds
4. terraform apply (first run — partial success)                   → 7 minutes
   - 35 resources created ✓
   - HTTPS listener FAILED (cert not validated)
   - ECS service FAILED (depends on listener)
5. Added ACM validation CNAME in Namecheap                        → 5 minutes
6. terraform apply (second run — completed)                        → 2 minutes
   - HTTPS listener created ✓
   - ECS service created ✓
7. Ran database migrations (one-off ECS task)                      → 1 minute
8. Added domain CNAME in Namecheap                                 → 5 minutes
9. Verified: health ✓, ready ✓, login ✓                           → 1 minute

Total time from zero to production: ~50 minutes
(minus the provider download issue: ~20 minutes)
```

---

## Architecture Diagram (What Was Deployed)

```
Internet
    │
    ▼
[DNS: churchidea.johndesiventures.website → ALB]
    │
    ▼
┌─── VPC (10.0.0.0/16) ──────────────────────────────────────────┐
│                                                                   │
│  Public Subnets                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  ALB (Application Load Balancer)                             │ │
│  │  - Port 80 → redirects to 443                               │ │
│  │  - Port 443 → forwards to Target Group (ECS tasks)          │ │
│  │  - ACM certificate for HTTPS (TLS 1.3)                      │ │
│  │  - Health check: GET /health every 30s                       │ │
│  │                                                              │ │
│  │  ECS Fargate Task (1 task, no NAT needed — public IP)        │ │
│  │  - Container: ghcr.io/bankolejohn/church-idea:latest         │ │
│  │  - Port 3000 (HTTP)                                          │ │
│  │  - Secrets injected: DATABASE_URL, JWT_SECRET                │ │
│  │  - Auto-scaling: CPU > 70% → add tasks (max 2)              │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  Private Subnets                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  RDS PostgreSQL (db.t3.micro)                                │ │
│  │  - Port 5432                                                 │ │
│  │  - ONLY accepts connections from ECS security group          │ │
│  │  - Encrypted at rest                                         │ │
│  │  - 3-day automated backups                                   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘

AWS Secrets Manager:
  - church-cms/dev/database-url → postgresql://...@rds:5432/churchdb
  - church-cms/dev/jwt-secret   → (random 64-char hex)
```

---

## Key Decisions and Why

| Decision | Why |
|----------|-----|
| NAT Gateway disabled in dev | Saves $32/month. Tasks get public IPs instead. |
| ECS tasks in public subnets (dev only) | Required when no NAT. Production uses private subnets + NAT. |
| ACM certificate with DNS validation | Free, auto-renews, no manual cert management. |
| Secrets in AWS Secrets Manager | Encrypted, audited, IAM-controlled. Never in env vars or code. |
| RDS in private subnets | Database unreachable from internet. Only ECS tasks can connect. |
| Circuit breaker enabled on ECS | Auto-rollback if new container keeps crashing. |
| db.t3.micro (dev) | Cheapest option. Production uses db.t3.small with Multi-AZ. |
| Provider version pinned to 5.31.0 | Avoids downloading 400MB+ on every init. Reproducible builds. |
