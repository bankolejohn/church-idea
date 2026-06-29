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

**What is terraform.tfvars?**

Terraform variables can be set in multiple ways. `terraform.tfvars` is a file that provides VALUES for variables declared in `variables.tf`. Think of it like `.env` for Terraform — it holds the secrets and environment-specific configuration that shouldn't be in code.

**Why a separate file?**

Your `variables.tf` declares:
```hcl
variable "db_password" {
  type      = string
  sensitive = true  # Terraform won't show this in plan output
}
```

But it doesn't set a VALUE. The value comes from `terraform.tfvars`:
```hcl
db_password = "ChurchCms2026Secure!"
```

This separation means:
- `variables.tf` is committed to git (declares WHAT secrets exist)
- `terraform.tfvars` is NOT committed (contains the ACTUAL secret values)
- Anyone cloning the repo can see what variables they need to set, without seeing your passwords

**What goes in terraform.tfvars:**

```bash
cat > terraform.tfvars << EOF
db_username = "churchadmin"
db_password = "$(openssl rand -base64 24)"
jwt_secret  = "$(openssl rand -hex 32)"
EOF
```

| Variable | What It's For | How to Generate |
|----------|--------------|-----------------|
| `db_username` | PostgreSQL admin username | Choose any name (avoid "admin" or "postgres" — these are targeted by attackers) |
| `db_password` | PostgreSQL admin password | `openssl rand -base64 24` (random, 24+ chars) |
| `jwt_secret` | Signs JWT tokens for user authentication | `openssl rand -hex 32` (random 64-char hex string) |

**Security rules for terraform.tfvars:**
1. NEVER commit it to git (it's in `.gitignore`)
2. NEVER share it in Slack/email
3. NEVER use the same values across environments (dev ≠ staging ≠ prod)
4. Store a backup in a password manager (1Password, Bitwarden)
5. If compromised: rotate immediately (`terraform apply` with new values recreates secrets)

**Alternative ways to provide variables (for CI/CD):**

```bash
# Option 1: Command-line flags (good for CI)
terraform apply -var="db_password=xxx" -var="jwt_secret=yyy"

# Option 2: Environment variables (prefix with TF_VAR_)
export TF_VAR_db_password="xxx"
export TF_VAR_jwt_secret="yyy"
terraform apply

# Option 3: Separate .tfvars file per environment
terraform apply -var-file="secrets.dev.tfvars"
```

In GitHub Actions (CI/CD), you'd use repository secrets:
```yaml
- run: terraform apply -auto-approve
  env:
    TF_VAR_db_password: ${{ secrets.DB_PASSWORD }}
    TF_VAR_jwt_secret: ${{ secrets.JWT_SECRET }}
```

**What Terraform does with these secrets:**

1. `db_username` + `db_password` → passed to the RDS module → creates the PostgreSQL database with these credentials
2. `db_username` + `db_password` + RDS endpoint → combined into a `DATABASE_URL` connection string → stored in AWS Secrets Manager
3. `jwt_secret` → stored in AWS Secrets Manager
4. ECS task starts → ECS agent reads from Secrets Manager → injects as environment variables into your container
5. Your app reads `process.env.DATABASE_URL` and `process.env.JWT_SECRET` — never knowing they came from Secrets Manager

The flow: `terraform.tfvars` → Terraform → AWS Secrets Manager → ECS agent → container env var → your app

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

### What Are Migrations?

When Terraform creates the RDS database, it creates an EMPTY PostgreSQL server — no tables, no data, nothing. It's like buying a filing cabinet with no folders inside.

**Migrations** are scripts that create the database schema (tables, indexes, constraints). They run in order and track what's already been applied, so you never run the same migration twice.

**Our migration file (`db/migrate.js`) creates:**
- `branches` table (church branches — name, address, pastor)
- `users` table (authentication — username, hashed password, role)
- `members` table (church members — name, phone, branch, department)
- `migrations` table (tracks which migrations have been applied)
- Indexes on `members.branch_id` and `users.username` (for query performance)

**Seeding (`db/seed.js`) creates:**
- One admin user: `admin` / `admin123` with role `main_leader`
- This is the initial user that can create branches and pastor accounts

### Why Migrations Are Separate from Deployment

In a real company, migrations and code deployment are SEPARATE concerns:

```
BAD:  Deploy new code → migration runs automatically inside the container on startup
      Problem: If migration fails, the app crashes. If you have 3 replicas, all 3 try
      to migrate simultaneously (race condition). Rollback is complex.

GOOD: Run migration FIRST (separate task) → THEN deploy new code
      Benefit: Migration runs once. If it fails, app isn't affected (old code still works).
      Migrations should be backward-compatible (new schema works with old AND new code).
```

### How We Run Migrations (One-Off ECS Task)

```bash
# Get network configuration
SUBNET=$(aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=church-cms-dev-public-1" \
  --query 'Subnets[0].SubnetId' --output text)

SG=$(aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=church-cms-dev-ecs-sg" \
  --query 'SecurityGroups[0].GroupId' --output text)

# Run migrations + seed as a one-off task
aws ecs run-task \
  --cluster church-cms-dev-cluster \
  --task-definition church-cms-dev \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"church-cms-app","command":["sh","-c","node db/migrate.js && node db/seed.js"]}]}'
```

**What this does:**
1. Launches a NEW container using the same image + secrets as the running app
2. Overrides the startup command (instead of `node server.js`, runs the migration scripts)
3. Migration script connects to RDS using the same `DATABASE_URL` from Secrets Manager
4. Creates tables, seeds admin user
5. Container exits (it's a one-shot task, not a long-running service)

### Verify Migrations Ran Successfully

```bash
# Check the task logs
aws logs tail /ecs/church-cms-dev --since 5m

# Expected output:
# Running migration: 001_create_tables
# Completed: 001_create_tables
# All migrations complete.
# Admin user created successfully
```

If you see `Skipped (already applied): 001_create_tables` — migrations already ran. That's fine.

### Alternative Approaches to Migrations

| Approach | How | Pros | Cons |
|----------|-----|------|------|
| **One-off ECS task (our choice)** | `aws ecs run-task --overrides` | Uses same image + secrets, no extra infra, runs in the same network | Manual command, need to remember after each deploy |
| **Init container (Kubernetes)** | Container that runs before the app starts | Automatic, no manual step | Not available on ECS Fargate (K8s only) |
| **Startup migration (on app boot)** | `require('./db/migrate')` at top of server.js | Fully automatic | Race conditions with multiple replicas, app crashes if migration fails |
| **CI/CD pipeline step** | GitHub Actions runs migration before deploy | Automated, centralized | CI needs network access to RDS (requires VPN or bastion) |
| **Bastion host / jump box** | SSH into a server in the VPC, run migration from there | Direct database access | Extra infrastructure to maintain, security risk |
| **AWS Lambda** | Lambda function triggered during deploy | Serverless, event-driven | Cold starts, execution time limits (15 min max) |
| **ECS Exec (interactive)** | `aws ecs execute-command` into running container | Can run any command interactively | Requires SSM agent, task must be running |

### The Best Practice (Production)

In production, the recommended approach is:

1. **Migrations run in CI/CD pipeline** (deploy-staging.yml already has a `migration-check` step)
2. **Before deploying new code**, a step runs `node db/migrate.js` via ECS run-task or ECS Exec
3. **Migrations are backward-compatible** — new columns are nullable, old columns aren't removed until the NEXT release
4. **Never seed in production** — seed is for dev/staging only. Production users are created through the app UI.

### ECS Exec Alternative (Interactive Shell)

If you need to run commands interactively inside a running container:

```bash
# Enable ECS Exec on the service (one-time)
aws ecs update-service --cluster church-cms-dev-cluster \
  --service church-cms-dev-service \
  --enable-execute-command

# Force a new deployment (picks up the exec config)
aws ecs update-service --cluster church-cms-dev-cluster \
  --service church-cms-dev-service \
  --force-new-deployment

# Wait for the new task to be running, then:
TASK_ARN=$(aws ecs list-tasks --cluster church-cms-dev-cluster \
  --service-name church-cms-dev-service --query 'taskArns[0]' --output text)

aws ecs execute-command --cluster church-cms-dev-cluster \
  --task $TASK_ARN --container church-cms-app \
  --interactive --command "/bin/sh"

# Now you're INSIDE the container:
$ node db/migrate.js
$ node db/seed.js
```

**Trade-offs:**
- Requires the SSM agent (included in Amazon Linux, works in Alpine with some config)
- Only works on a RUNNING task (can't exec into a task that already crashed)
- Leaves no audit trail (one-off ECS tasks are logged, exec sessions aren't by default)
- Useful for debugging, risky for production operations

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

## Redeployment After Destroy

### What Happens When You Destroy and Re-Apply

If you `terraform destroy` and later `terraform apply` to bring everything back, most things recreate cleanly — but some require manual intervention.

**What recreates automatically (no action needed):**
- VPC, subnets, route tables, Internet Gateway
- IAM roles and policies
- ECS cluster, task definition, service
- CloudWatch log group
- Security groups

**What breaks and needs fixing:**

| Issue | Why It Breaks | How to Fix |
|-------|---------------|------------|
| ACM certificate needs revalidation | New cert = new validation hash | Add new CNAME in Namecheap (different from last time) |
| ALB has a new DNS name | New ALB = new random hostname | Update `churchidea` CNAME in Namecheap |
| Database is empty | RDS destroyed = all data gone | Run migrations + seed again |
| Secrets Manager name conflict | AWS keeps deleted secrets for 7 days | Restore + import (see below) |
| DNS propagation delay | New records need time | Wait 2-15 minutes |

### The Secrets Manager 7-Day Problem

This is the sneakiest issue. When Terraform destroys a secret, AWS doesn't actually delete it — it schedules deletion in 7 days (recovery window). If you `apply` again within those 7 days:

```
Error: creating Secrets Manager Secret: resource already exists
```

**Fix:**

```bash
# Restore the pending-deletion secrets
aws secretsmanager restore-secret --secret-id "church-cms/dev/database-url"
aws secretsmanager restore-secret --secret-id "church-cms/dev/jwt-secret"

# Import them into Terraform state (so Terraform manages them again)
terraform import 'module.secrets.aws_secretsmanager_secret.database_url' \
  $(aws secretsmanager describe-secret --secret-id "church-cms/dev/database-url" --query 'ARN' --output text)

terraform import 'module.secrets.aws_secretsmanager_secret.jwt_secret' \
  $(aws secretsmanager describe-secret --secret-id "church-cms/dev/jwt-secret" --query 'ARN' --output text)

# Now apply works
terraform apply
```

**Alternative:** Wait 7 days and the old secrets fully delete. Then `apply` works without import.

### The Full Redeployment Sequence

```bash
# 1. Apply (creates 37 resources, ~7 minutes)
#    First run will partially fail (ACM cert not validated)
terraform apply

# 2. Get the new ACM validation record
terraform output certificate_validation
# → Add new CNAME in Namecheap (the hash WILL be different from before)

# 3. Wait for certificate validation (2-5 min)
aws acm describe-certificate \
  --certificate-arn $(aws acm list-certificates --query 'CertificateSummaryList[0].CertificateArn' --output text) \
  --query 'Certificate.Status' --output text
# Wait until: ISSUED

# 4. Apply again (creates HTTPS listener + ECS service)
terraform apply

# 5. Run migrations (database is empty after recreate)
SUBNET=$(aws ec2 describe-subnets --filters "Name=tag:Name,Values=church-cms-dev-public-1" \
  --query 'Subnets[0].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups --filters "Name=tag:Name,Values=church-cms-dev-ecs-sg" \
  --query 'SecurityGroups[0].GroupId' --output text)

aws ecs run-task \
  --cluster church-cms-dev-cluster \
  --task-definition church-cms-dev \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"church-cms-app","command":["sh","-c","node db/migrate.js && node db/seed.js"]}]}'

# 6. Update domain CNAME (ALB DNS name changed)
terraform output alb_raw_dns
# → Update `churchidea` CNAME in Namecheap to the new ALB DNS

# 7. Wait 2-5 minutes for DNS, then verify
curl -s https://churchidea.johndesiventures.website/health
curl -s https://churchidea.johndesiventures.website/ready
```

### When Would You Destroy and Redeploy?

| Scenario | Action |
|----------|--------|
| Save money on weekends (dev/staging) | Destroy Friday, apply Monday |
| Major infrastructure change (VPC CIDR change) | Destroy + recreate |
| Environment is corrupted beyond repair | Destroy + recreate |
| Learning/experimenting | Destroy freely |
| **Production** | **NEVER destroy.** Update in place. |

### Cost Savings Without Destroying Everything

If you want to save compute costs without losing the database and infra:

```bash
# Scale ECS to 0 tasks (saves ~$9/month, keeps RDS + ALB running)
aws ecs update-service --cluster church-cms-dev-cluster \
  --service church-cms-dev-service --desired-count 0

# Scale back up when needed
aws ecs update-service --cluster church-cms-dev-cluster \
  --service church-cms-dev-service --desired-count 1
```

This keeps RDS running (data preserved) and ALB active (DNS still works) but stops the container (no compute charges). You still pay ~$32/month for RDS + ALB.

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
| NAT Gateway ENABLED in staging | Mirrors production. Tasks in private subnets (more secure). |
| ECS tasks in public subnets (dev only) | Required when no NAT. Production uses private subnets + NAT. |
| ACM certificate with DNS validation | Free, auto-renews, no manual cert management. |
| Secrets in AWS Secrets Manager | Encrypted, audited, IAM-controlled. Never in env vars or code. |
| RDS in private subnets | Database unreachable from internet. Only ECS tasks can connect. |
| Circuit breaker enabled on ECS | Auto-rollback if new container keeps crashing. |
| db.t3.micro (dev) / db.t3.small (staging) | Right-size per environment. Production uses .small with Multi-AZ. |
| Provider version pinned to 5.30.0 | Avoids downloading 400MB+ on every init. Reproducible builds. |
| Separate VPC per environment | Complete network isolation. Dev can't accidentally affect staging. |
| 1 task (dev) / 2 tasks (staging) | Dev is cheap. Staging proves HA and load balancing work. |

---

## How Multi-Environment Works (Dev / Staging / Production)

### The Concept

All three environments run **simultaneously** on AWS. They are completely independent — different VPCs, different databases, different load balancers. They share NOTHING except the same AWS account and the same Terraform module code.

```
infrastructure/terraform/environments/
├── dev/      → terraform apply → VPC 10.0.0.0/16, own ALB, own RDS, own ECS
├── staging/  → terraform apply → VPC 10.1.0.0/16, own ALB, own RDS, own ECS
└── prod/     → terraform apply → VPC 10.2.0.0/16, own ALB, own RDS, own ECS
```

Think of modules as BLUEPRINTS. Each environment is a different HOUSE built from the same blueprint — different sizes, different security levels, different costs.

### How Each Environment Gets Created

You run `terraform apply` in each folder independently. Each has its own:
- `main.tf` — wires modules together with environment-specific parameters
- `variables.tf` — declares inputs (same across environments)
- `terraform.tfvars` — holds secrets (DIFFERENT per environment, never committed)
- State file — stored in S3 under a different key (`dev/terraform.tfstate`, `staging/terraform.tfstate`, `prod/terraform.tfstate`)

### The Lifecycle in a Real Company

| Phase | Who Runs It | How |
|-------|-------------|-----|
| Initial creation (Day 1) | Senior DevOps engineer | Manual `terraform apply` in each folder |
| Ongoing infra changes | CI/CD pipeline | PR → plan shown in PR comment → merge → auto-apply |
| App code deploys | CI/CD pipeline | deploy-staging.yml (auto) / deploy-prod.yml (manual trigger) |
| Emergency changes | Senior on-call engineer | Manual `terraform apply` with PR approval |

**In production-grade companies, you NEVER run `terraform apply` manually for staging or prod after initial setup.** Instead:
1. Engineer opens PR changing Terraform files
2. CI runs `terraform plan` and posts the output as a PR comment
3. Team reviews the plan (someone eyeballs every resource change)
4. PR is merged → CI runs `terraform apply` automatically
5. If something breaks → `git revert` the PR → CI applies the revert

### Cost Reality

| Strategy | When | Monthly Cost |
|----------|------|-------------|
| All 3 running 24/7 | Funded startup / company with revenue | ~$361/month |
| Dev + staging, destroy when not testing | Learning / pre-revenue | ~$41-120/month |
| Dev only, staging on-demand | Solo developer / tight budget | ~$41/month |

### Environment Isolation (Why Separate VPCs)

Each environment has its own VPC with a different CIDR range:
- Dev: `10.0.0.0/16`
- Staging: `10.1.0.0/16`
- Prod: `10.2.0.0/16`

This means:
- A bug in dev CANNOT affect production (different networks)
- A security group misconfiguration in staging doesn't expose prod
- You can destroy dev without touching staging or prod
- Each has its own Terraform state — `terraform destroy` in dev/ only destroys dev

---

### How Staging Differs

| Aspect | Dev | Staging |
|--------|-----|---------|
| VPC CIDR | 10.0.0.0/16 | 10.1.0.0/16 |
| NAT Gateway | Disabled ($0) | Enabled ($32/month) |
| ECS tasks in | Public subnets | Private subnets |
| Public IP on tasks | Yes | No (uses NAT) |
| ECS task count | 1 | 2 |
| CPU / Memory | 256 / 512 | 512 / 1024 |
| RDS instance | db.t3.micro | db.t3.small |
| Backup retention | 3 days | 7 days |
| Log retention | 7 days | 14 days |
| HTTPS | Yes (ACM cert) | No (HTTP only — optional to add) |
| Estimated cost | ~$41/month | ~$120/month |

### Staging Deploy Steps

```bash
# 1. Navigate to staging
cd infrastructure/terraform/environments/staging

# 2. Create secrets (DIFFERENT values from dev — never reuse!)
cat > terraform.tfvars << EOF
db_username = "churchadmin"
db_password = "$(openssl rand -base64 24)"
jwt_secret  = "$(openssl rand -hex 32)"
EOF

# 3. Initialize
terraform init -plugin-dir=/Users/YOUR_USERNAME/.terraform.d/plugins

# 4. Preview
terraform plan
# Expected: Plan: ~40 to add (more than dev because NAT Gateway adds resources)

# 5. Deploy
terraform apply
# Takes ~10 minutes (NAT Gateway + RDS are slowest)
# Should succeed fully (no HTTPS = no ACM validation needed)

# 6. Get ALB DNS name
terraform output alb_dns_name
# http://church-cms-staging-alb-XXXXXXX.us-east-1.elb.amazonaws.com
```

### Run Migrations on Staging

**IMPORTANT:** Staging uses PRIVATE subnets, so the migration command is different from dev:

```bash
# Get PRIVATE subnet and security group
SUBNET=$(aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=church-cms-staging-private-1" \
  --query 'Subnets[0].SubnetId' --output text)

SG=$(aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=church-cms-staging-ecs-sg" \
  --query 'SecurityGroups[0].GroupId' --output text)

# Run migrations (NOTE: assignPublicIp=DISABLED — uses NAT for internet)
aws ecs run-task \
  --cluster church-cms-staging-cluster \
  --task-definition church-cms-staging \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"church-cms-app","command":["sh","-c","node db/migrate.js && node db/seed.js"]}]}'
```

**Why `assignPublicIp=DISABLED` for staging but `ENABLED` for dev?**
- Dev: tasks are in PUBLIC subnets (no NAT) → need public IP to pull images from GHCR
- Staging: tasks are in PRIVATE subnets (have NAT) → NAT provides internet access, no public IP needed

### Verify Staging

```bash
ALB=$(terraform output -raw alb_dns_name | sed 's|http://||')

curl -s http://$ALB/health
# {"status":"ok","timestamp":"...","uptime":...}

curl -s http://$ALB/ready
# {"status":"ready","database":"connected"}

curl -s -X POST http://$ALB/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# {"token":"eyJ...","user":{...}}
```

---

## Deploying Production

### How Production Differs from Dev/Staging

| Aspect | Dev | Staging | Production |
|--------|-----|---------|------------|
| VPC CIDR | 10.0.0.0/16 | 10.1.0.0/16 | 10.2.0.0/16 |
| NAT Gateway | Disabled ($0) | Enabled ($32) | Enabled ($32) |
| ECS tasks in | Public subnets | Private subnets | Private subnets |
| ECS task count | 1 | 2 | 2 (scales to 6) |
| CPU / Memory | 256 / 512 | 512 / 1024 | 512 / 1024 |
| RDS instance | db.t3.micro | db.t3.small | db.t3.small |
| RDS Multi-AZ | No | No | **Yes** (auto failover) |
| Backup retention | 3 days | 7 days | **30 days** |
| Log retention | 7 days | 14 days | **90 days** |
| HTTPS | Yes | No | **Yes** |
| Deletion protection (RDS) | No | No | **Yes** |
| Performance Insights | No | No | **Yes** |
| Estimated cost | ~$41/month | ~$120/month | ~$200/month |

### Production-Specific Features

1. **Multi-AZ RDS:** Database has a standby replica in a different AZ. If the primary AZ fails, AWS automatically promotes the standby (<60s failover).
2. **HTTPS with ACM:** All traffic encrypted in transit (TLS 1.3).
3. **Deletion protection:** Cannot accidentally destroy the database via `terraform destroy` or AWS console.
4. **90-day log retention:** For compliance and post-incident analysis.
5. **30-day backups:** Point-in-time recovery to any second in the last 30 days.
6. **Auto-scaling to 6 tasks:** Handles traffic spikes without manual intervention.

### Production Deploy Steps

```bash
# 1. Navigate to production
cd infrastructure/terraform/environments/prod

# 2. Create secrets (UNIQUE to production — never reuse from dev/staging!)
cat > terraform.tfvars << EOF
db_username = "churchadmin"
db_password = "$(openssl rand -base64 32)"
jwt_secret  = "$(openssl rand -hex 64)"
EOF
# NOTE: Production uses LONGER passwords (32 chars) and secrets (128 hex chars)

# 3. Initialize
terraform init -plugin-dir=/Users/YOUR_USERNAME/.terraform.d/plugins

# 4. Preview
terraform plan
# Expected: Plan: 39 to add (more than staging — Multi-AZ + ACM + Performance Insights)

# 5. Deploy (first run — partial failure expected for ACM cert)
terraform apply
```

### Validate ACM Certificate

```bash
# Get the DNS validation record
terraform output certificate_validation
```

**In Namecheap:**

| Type | Host | Target |
|------|------|--------|
| CNAME | `_xxxxx.app` | `_yyyyy.acm-validations.aws.` |

Wait 2-5 minutes, verify:
```bash
aws acm describe-certificate \
  --certificate-arn $(aws acm list-certificates --query "CertificateSummaryList[?DomainName=='app.johndesiventures.website'].CertificateArn" --output text) \
  --query 'Certificate.Status' --output text
# Wait until: ISSUED
```

Then complete:
```bash
terraform apply
```

### Run Migrations on Production

```bash
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

**IMPORTANT:** In a real company, NEVER seed in production. The seed creates `admin/admin123`. For this learning project it's fine — but production should create admin users through a secure process.

### Configure Domain DNS

```bash
terraform output alb_raw_dns
```

In Namecheap:

| Type | Host | Target |
|------|------|--------|
| CNAME | `app` | `church-cms-prod-alb-XXXXXXX.us-east-1.elb.amazonaws.com` |

### Verify Production

```bash
curl -s https://app.johndesiventures.website/health
curl -s https://app.johndesiventures.website/ready
curl -s -X POST https://app.johndesiventures.website/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

### Production Operations Cheat Sheet

```bash
# View logs in real-time
aws logs tail /ecs/church-cms-prod --follow

# Check service health
aws ecs describe-services --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].{desired:desiredCount,running:runningCount,status:status}'

# Force a new deployment (pulls latest image)
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --force-new-deployment

# Scale up for expected traffic
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --desired-count 4

# Scale back down
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --desired-count 2
```

---

## All Three Environments — Summary

```
DEV:        https://churchidea.johndesiventures.website
            1 task | HTTPS | Public subnet | db.t3.micro | ~$41/month

STAGING:    http://church-cms-staging-alb-XXXXX.us-east-1.elb.amazonaws.com
            2 tasks | HTTP only | Private subnet + NAT | db.t3.small | ~$120/month

PRODUCTION: https://app.johndesiventures.website
            2 tasks | HTTPS | Private subnet + NAT | db.t3.small Multi-AZ | ~$200/month

TOTAL COST: ~$361/month (all three running simultaneously)
```

### Quick Commands Reference

| Task | Dev | Staging | Production |
|------|-----|---------|------------|
| Navigate | `cd environments/dev` | `cd environments/staging` | `cd environments/prod` |
| Deploy infra | `terraform apply` | `terraform apply` | `terraform apply` (with approval) |
| Migrations | `assignPublicIp=ENABLED` | `assignPublicIp=DISABLED` | `assignPublicIp=DISABLED` |
| Cluster name | `church-cms-dev-cluster` | `church-cms-staging-cluster` | `church-cms-prod-cluster` |
| Subnet filter | `church-cms-dev-public-1` | `church-cms-staging-private-1` | `church-cms-prod-private-1` |
| Destroy safe? | Yes (freely) | Yes (recreate when needed) | **NEVER** (scale instead) |

---

## Production Hands-On Exercises

These exercises simulate real production scenarios. Build confidence by running them.

### Exercise 1: Simulate a Traffic Spike (Scale Up/Down)

```bash
# Scale to 4 tasks (preparing for high traffic)
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --desired-count 4

# Watch tasks come up (Ctrl+C to stop)
watch -n 5 'aws ecs describe-services --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query "services[0].{desired:desiredCount,running:runningCount}" --output table'

# Scale back down
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --desired-count 2
```

### Exercise 2: Deploy a New Version (Rolling Update)

```bash
# Force ECS to pull latest image and roll out new tasks
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --force-new-deployment

# Watch the rolling update
aws ecs describe-services --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].deployments[*].{status:status,desired:desiredCount,running:runningCount}' \
  --output table
```

### Exercise 3: View Logs During an Issue

```bash
# Follow logs in real-time (terminal 1)
aws logs tail /ecs/church-cms-prod --follow

# In terminal 2, generate a failed login:
curl -s -X POST https://app.johndesiventures.website/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"attacker","password":"wrong"}'

# Watch "Failed login attempt" appear in terminal 1
```

### Exercise 4: Check What's Exposed (Security Audit)

```bash
# Is RDS publicly accessible? (should be: false)
aws rds describe-db-instances \
  --db-instance-identifier church-cms-prod-db \
  --query 'DBInstances[0].PubliclyAccessible'

# What ports are open on the ALB security group?
aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=church-cms-prod-alb-sg" \
  --query 'SecurityGroups[0].IpPermissions[*].{Port:FromPort,Source:IpRanges[0].CidrIp}'

# What can the ECS tasks access?
aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=church-cms-prod-ecs-sg" \
  --query 'SecurityGroups[0].{Ingress:IpPermissions,Egress:IpPermissionsEgress}'
```

### Exercise 5: Test Database Failover (Multi-AZ)

```bash
# Check current AZ of the primary
aws rds describe-db-instances \
  --db-instance-identifier church-cms-prod-db \
  --query 'DBInstances[0].{AZ:AvailabilityZone,MultiAZ:MultiAZ,Status:DBInstanceStatus}'

# Trigger a failover (simulates AZ failure — causes ~30s downtime)
# WARNING: Only do this if you understand it causes brief interruption
aws rds reboot-db-instance \
  --db-instance-identifier church-cms-prod-db \
  --force-failover

# Watch the app recover (hit /ready repeatedly)
for i in $(seq 1 20); do
  echo "$(date): $(curl -s https://app.johndesiventures.website/ready | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status","ERROR"))' 2>/dev/null || echo 'UNREACHABLE')"
  sleep 5
done
```

This shows you: the database failover takes ~30 seconds, during which `/ready` returns 503 or fails. After failover, it recovers automatically. The app itself (container) never restarts — only the DB connection reconnects.

---
