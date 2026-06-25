# Infrastructure as Code & Deployment Strategy — Deep Dive

This document explains the complete infrastructure and deployment system for the Church CMS project.
It covers Terraform modules, how they connect, the deployment pipeline, and hands-on guidance.

---

## Table of Contents

1. [Why Infrastructure as Code](#why-infrastructure-as-code)
2. [Terraform Fundamentals](#terraform-fundamentals)
3. [Architecture Overview](#architecture-overview)
4. [The Module System (How Everything Connects)](#the-module-system)
5. [Module Deep Dives](#module-deep-dives)
6. [Environment Configuration](#environment-configuration)
7. [The Deployment Pipeline (End to End)](#the-deployment-pipeline)
8. [Deployment Strategies Explained](#deployment-strategies-explained)
9. [Hands-On: Working with Terraform](#hands-on-working-with-terraform)
10. [Hands-On: Triggering Deployments](#hands-on-triggering-deployments)
11. [Cost Optimization Decisions](#cost-optimization-decisions)
12. [Key Concepts for Interviews](#key-concepts-for-interviews)

---

## Why Infrastructure as Code

**The old way (ClickOps):**
1. Log into AWS Console
2. Click through 15 screens to create a VPC
3. Click through 10 more for subnets
4. Forget which settings you used
5. Try to recreate the same thing for staging — get it slightly wrong
6. 3 months later, someone asks "why is this security group open?" — nobody knows

**The IaC way:**
1. Write code that describes your infrastructure
2. `terraform apply` — creates everything in seconds
3. The code IS the documentation
4. Same code → same infrastructure (dev = staging = prod)
5. Changes are reviewed via PR (just like application code)
6. Destroy and recreate in minutes (disaster recovery)

**The core promise:** Your infrastructure is reproducible, reviewable, and reversible.

---

## Terraform Fundamentals

### How Terraform Works (The Loop)

```
terraform init    → Downloads providers (AWS, Azure, etc.)
terraform plan    → Compares desired state (code) vs actual state (AWS)
terraform apply   → Makes changes to reach desired state
terraform destroy → Removes everything
```

### Key Concepts

| Concept | What It Is | Example |
|---------|-----------|---------|
| **Provider** | Plugin that talks to a cloud API | `hashicorp/aws` |
| **Resource** | A single infrastructure object | `aws_ecs_service`, `aws_db_instance` |
| **Module** | A reusable group of resources | Our `vpc`, `ecs`, `rds` modules |
| **State** | Terraform's record of what exists | Stored in S3 (remote backend) |
| **Variable** | Input parameter to a module | `instance_class = "db.t3.micro"` |
| **Output** | Value exported from a module | `vpc_id`, `cluster_name` |
| **Backend** | Where state is stored | S3 bucket + DynamoDB lock |

### State: The Most Important Concept

Terraform state is a JSON file that maps your code to real AWS resources.

```
Your code says:         State says:              AWS has:
aws_vpc "main" {...} → "vpc-0abc123" → Actual VPC in us-east-1
```

Without state, Terraform doesn't know what exists. It would try to CREATE everything again (duplicating your infrastructure).

**Our setup:** State is in S3 (`church-cms-terraform-state-547624429131`) with DynamoDB locking (prevents two people from `apply`ing simultaneously).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AWS (us-east-1)                                │
│                                                                       │
│  ┌───────────── VPC (10.0.0.0/16) ────────────────────────────────┐ │
│  │                                                                  │ │
│  │  Public Subnets (10.0.0.0/24, 10.0.1.0/24)                     │ │
│  │  ┌────────────────────────────────────────────────────────────┐ │ │
│  │  │  Internet Gateway ←→ ALB (Application Load Balancer)       │ │ │
│  │  │     ↓                    Port 80 → redirect to 443         │ │ │
│  │  │  NAT Gateway             Port 443 → Target Group (ECS)     │ │ │
│  │  │  (optional, $32/mo)                                        │ │ │
│  │  └────────────────────────────────────────────────────────────┘ │ │
│  │                                                                  │ │
│  │  Private Subnets (10.0.2.0/24, 10.0.3.0/24)                    │ │
│  │  ┌────────────────────────────────────────────────────────────┐ │ │
│  │  │                                                            │ │ │
│  │  │  ECS Fargate Tasks (church-cms-app container)              │ │ │
│  │  │     ├── Port 3000 (HTTP)                                   │ │ │
│  │  │     ├── Port 9464 (Prometheus metrics)                     │ │ │
│  │  │     ├── Pulls secrets from Secrets Manager                 │ │ │
│  │  │     └── Connects to RDS on port 5432                       │ │ │
│  │  │                                                            │ │ │
│  │  │  RDS PostgreSQL (db.t3.micro)                              │ │ │
│  │  │     ├── Encrypted at rest                                  │ │ │
│  │  │     ├── Automated backups (3-30 days by env)               │ │ │
│  │  │     └── Only accepts connections from ECS security group   │ │ │
│  │  │                                                            │ │ │
│  │  └────────────────────────────────────────────────────────────┘ │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ ACM          │  │ Secrets Mgr  │  │ CloudWatch                │  │
│  │ (SSL cert)   │  │ DATABASE_URL │  │ Logs + Auto Scaling       │  │
│  │              │  │ JWT_SECRET   │  │ CPU/Memory target tracking │  │
│  └──────────────┘  └──────────────┘  └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The Module System

### How Modules Connect (Data Flow)

```
environments/dev/main.tf (THE ORCHESTRATOR)
        │
        ├── module "vpc"      → Creates: VPC, subnets, IGW, NAT, route tables
        │     │                  Exports: vpc_id, public_subnet_ids, private_subnet_ids
        │     │
        ├── module "alb"      ← Uses: vpc_id, public_subnet_ids
        │     │                  Creates: ALB, target groups, listeners, security group
        │     │                  Exports: target_group_arn, alb_security_group_id
        │     │
        ├── module "secrets"  ← Uses: (just project/env names + secret values)
        │     │                  Creates: Secrets Manager entries
        │     │                  Exports: secret ARNs
        │     │
        ├── module "ecs"      ← Uses: vpc_id, subnet_ids, alb_sg_id, target_group_arn, secret_arns
        │     │                  Creates: Cluster, task def, service, IAM roles, SG, auto-scaling
        │     │                  Exports: cluster_name, service_name, security_group_id
        │     │
        └── module "rds"      ← Uses: vpc_id, private_subnet_ids, ecs_security_group_id
                                 Creates: DB instance, subnet group, security group
                                 Exports: endpoint (used to build DATABASE_URL)
```

**The key insight:** Modules are connected via their OUTPUTS. One module's output becomes another module's input. The environment config (`main.tf`) is the glue that wires everything together.

### Why Modules (Not One Big File)

| Approach | Problem |
|----------|---------|
| One big `main.tf` | 500+ lines, impossible to navigate, can't reuse |
| Separate modules | Each is 50-80 lines, focused, testable, reusable across envs |

Modules let you:
- Change the VPC without touching ECS code
- Reuse the same RDS module in dev/staging/prod with different parameters
- Review PRs that only touch one concern (networking vs compute vs database)

---

## Module Deep Dives

### VPC Module (`infrastructure/terraform/modules/vpc/`)

**What it creates:** The network foundation. Everything else lives inside this.

| Resource | Purpose |
|----------|---------|
| `aws_vpc` | The isolated network (10.0.0.0/16 = 65,536 IP addresses) |
| `aws_subnet` (public × 2) | For ALB — has direct internet access via IGW |
| `aws_subnet` (private × 2) | For ECS + RDS — no direct internet (security) |
| `aws_internet_gateway` | Allows public subnets to reach the internet |
| `aws_nat_gateway` (optional) | Allows private subnets to reach internet (for pulling images) |
| `aws_route_table` × 2 | Routing rules (public → IGW, private → NAT) |

**Key design decision — NAT Gateway is optional:**
```hcl
variable "enable_nat_gateway" {
  type    = bool
  default = true
}
```
NAT costs ~$32/month. In dev, we disable it and put ECS tasks in public subnets with public IPs instead. In staging/prod, NAT is enabled (tasks stay private).

**Why 2 Availability Zones:**
AWS requires subnets in at least 2 AZs for high availability. If one AZ has an outage, the other keeps running.

---

### ALB Module (`infrastructure/terraform/modules/alb/`)

**What it creates:** The entry point for all external traffic.

| Resource | Purpose |
|----------|---------|
| `aws_lb` | Application Load Balancer (Layer 7 — understands HTTP) |
| `aws_lb_target_group` (blue) | Routes traffic to current ECS tasks |
| `aws_lb_target_group` (green) | Routes traffic to new version during canary deploy |
| `aws_lb_listener` (HTTP:80) | Redirects to HTTPS (or forwards if no cert) |
| `aws_lb_listener` (HTTPS:443) | Terminates SSL, forwards to target group |
| `aws_security_group` | Allows 80/443 from internet, all outbound |

**The blue/green target group pattern:**
```hcl
resource "aws_lb_target_group" "app_green" {
  count = var.enable_blue_green ? 1 : 0  # Only in prod
  ...
}
```
Dev/staging: one target group (rolling updates).
Production: two target groups (CodeDeploy shifts traffic between them).

**Health checks:** ALB checks `/health` every 30 seconds. If 3 checks fail, the task is marked unhealthy and removed from the target group (traffic stops going to it).

---

### ECS Module (`infrastructure/terraform/modules/ecs/`)

**What it creates:** The compute layer — where your containers actually run.

| Resource | Purpose |
|----------|---------|
| `aws_ecs_cluster` | Logical grouping of services |
| `aws_ecs_task_definition` | Blueprint for your container (image, CPU, memory, env vars, secrets) |
| `aws_ecs_service` | Manages desired count, rolling updates, load balancer attachment |
| `aws_iam_role` (execution) | ECS agent uses this to pull images + read secrets |
| `aws_iam_role` (task) | Your application code uses this for AWS API calls |
| `aws_security_group` | Only allows traffic FROM the ALB (not direct internet) |
| `aws_appautoscaling_*` | Auto-scales based on CPU (70%) and memory (80%) |

**Two IAM roles — why:**
- **Execution role:** Used by the ECS AGENT (not your code). Pulls Docker images from GHCR, reads secrets from Secrets Manager, writes logs to CloudWatch.
- **Task role:** Used by YOUR APPLICATION CODE. If your app needs to call S3 or SQS, you'd attach policies here. Currently empty (app only talks to RDS via DATABASE_URL).

**The circuit breaker:**
```hcl
deployment_circuit_breaker {
  enable   = true
  rollback = true
}
```
If new tasks keep failing health checks during a deploy, ECS automatically rolls back to the previous task definition. No human intervention needed.

---

### RDS Module (`infrastructure/terraform/modules/rds/`)

**What it creates:** The managed PostgreSQL database.

| Resource | Purpose |
|----------|---------|
| `aws_db_instance` | The actual database server |
| `aws_db_subnet_group` | Tells RDS which subnets to use (private only) |
| `aws_security_group` | Only allows port 5432 FROM the ECS security group |

**Security design:** RDS is in private subnets with a security group that ONLY allows connections from ECS tasks. You cannot connect to the database from the internet, from your laptop, or from any other AWS service. Only your application.

**Environment differences:**

| Setting | Dev | Prod |
|---------|-----|------|
| Instance | db.t3.micro | db.t3.small |
| Multi-AZ | No | Yes (automatic failover) |
| Backups | 3 days | 30 days |
| Deletion protection | No | Yes (can't accidentally destroy) |
| Performance Insights | No | Yes (query-level metrics) |
| Final snapshot | Skip | Required |

---

### Secrets Module (`infrastructure/terraform/modules/secrets/`)

**What it creates:** Encrypted storage for sensitive values.

| Secret | Content |
|--------|---------|
| `church-cms/dev/database-url` | `postgresql://user:pass@rds-endpoint:5432/churchdb` |
| `church-cms/dev/jwt-secret` | Random string for JWT signing |

**Why Secrets Manager (not environment variables):**
- Encrypted at rest (AES-256)
- Access controlled via IAM (only the ECS execution role can read them)
- Audit trail (CloudTrail logs every access)
- Rotation capability (can auto-rotate database passwords)
- Never appears in `terraform plan` output or state in plain text (marked `sensitive`)

**How ECS reads secrets:**
```json
"secrets": [
  { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:...:database-url" }
]
```
ECS agent reads the secret at task start time and injects it as an environment variable. Your code uses `process.env.DATABASE_URL` — it never knows it came from Secrets Manager.

---

### CodeDeploy Module (`infrastructure/terraform/modules/codedeploy/`)

**What it creates:** The canary deployment system for production.

| Resource | Purpose |
|----------|---------|
| `aws_codedeploy_app` | Container for deployment groups |
| `aws_codedeploy_deployment_group` | Strategy, alarms, ECS service reference |
| `aws_iam_role` | Permissions to manage ECS + ALB |
| `aws_cloudwatch_metric_alarm` × 3 | Gates: 5xx errors, unhealthy hosts, high latency |

**The deployment flow:**
1. New task definition is registered (new image version)
2. CodeDeploy launches new tasks in GREEN target group
3. Once healthy, shifts 10% traffic to green
4. Monitors CloudWatch alarms for 5 minutes
5. If any alarm fires → instant rollback (reroute 100% back to blue)
6. If clean → shift remaining 90% to green
7. Wait 10 minutes (rollback window)
8. Terminate old (blue) tasks

---

## Environment Configuration

### How Environments Work

Each environment has its own directory with its own `main.tf`:

```
infrastructure/terraform/environments/
├── dev/        ← 10.0.0.0/16, no NAT, 1 task, db.t3.micro
├── staging/    ← 10.1.0.0/16, NAT, 2 tasks, db.t3.small
└── prod/       ← 10.2.0.0/16, NAT, 3 tasks, db.t3.small, multi-AZ, CodeDeploy
```

Each environment:
- Has its own VPC (isolated networks — can't accidentally affect each other)
- Has its own Terraform state file (changes to dev don't risk prod state)
- Uses the SAME modules (consistency) with DIFFERENT parameters (appropriate sizing)

### The Orchestrator Pattern (dev/main.tf)

```hcl
# This is what "wiring modules together" looks like:

module "vpc" { ... }              # Step 1: Create the network

module "secrets" {                 # Step 2: Create secrets
  database_url = "...${module.rds.endpoint}..."  # ← Uses RDS output
}

module "alb" {                     # Step 3: Create load balancer
  vpc_id = module.vpc.vpc_id       # ← Uses VPC output
  public_subnet_ids = module.vpc.public_subnet_ids
}

module "ecs" {                     # Step 4: Create compute
  vpc_id = module.vpc.vpc_id
  alb_security_group_id = module.alb.alb_security_group_id  # ← Uses ALB output
  target_group_arn = module.alb.target_group_arn
  secrets_arns = module.secrets.all_secret_arns              # ← Uses Secrets output
}

module "rds" {                     # Step 5: Create database
  ecs_security_group_id = module.ecs.security_group_id  # ← Uses ECS output
}
```

Notice: there's a CIRCULAR DEPENDENCY between ECS and RDS (ECS needs RDS endpoint for secrets, RDS needs ECS security group for access). Terraform handles this by building a dependency graph and creating resources in the right order.

---

## The Deployment Pipeline

### The Complete Flow (Code → Production)

```
Developer writes code
        │
        ▼
Opens PR → CI Pipeline (ci.yml)
        │    ├── Lint (ESLint)
        │    ├── Tests (Jest + PostgreSQL service container)
        │    ├── Security scan (Trivy + CodeQL)
        │    ├── Docker build (validates Dockerfile)
        │    └── Container image scan (Trivy on built image)
        │
        ▼
PR approved + merged to main
        │
        ├─── deploy-staging.yml (AUTOMATIC)
        │      ├── Build image → push to GHCR (sha + "staging" tags)
        │      ├── Migration pre-check (DB connectivity, pending migrations)
        │      ├── Deploy to ECS staging (rolling update)
        │      ├── Integration tests (curl-based, 30 seconds)
        │      ├── E2E tests (Cypress, real browser)
        │      └── "Staging Verified" ✅
        │
        ├─── release.yml (AUTOMATIC)
        │      ├── release-please analyzes commits
        │      ├── Opens "Release PR" (bumps version, generates changelog)
        │      └── When Release PR merged → creates GitHub Release + tags image
        │
        └─── security-supply-chain.yml (AUTOMATIC)
               ├── Trivy IaC scan (Terraform misconfigs)
               ├── Build + Cosign sign (image provenance)
               ├── Syft SBOM generation (dependency inventory)
               └── Trivy SBOM vulnerability scan

═══ LATER (you decide when) ═══════════════════════════════════════

deploy-prod.yml (MANUAL TRIGGER)
        ├── Validate (confirm intent + image exists + Cosign verify)
        ├── Staging gate (queries GitHub API — did staging pass?)
        ├── Migration pre-check (against prod DB)
        ├── Deploy to ECS (rolling update, 15 min stability wait)
        ├── Post-deploy integration tests
        └── Auto-rollback if verification fails

    OR

deploy-prod-canary.yml (MANUAL TRIGGER — maximum safety)
        ├── Validate (image exists)
        ├── Register new task definition
        ├── Create CodeDeploy deployment (AppSpec)
        ├── CodeDeploy: 10% traffic → green (5 min monitor)
        ├── CloudWatch alarms: 5xx? latency? unhealthy?
        ├── If clean → 100% shift → terminate blue after 10 min
        └── If alarm fires → instant rollback
```

### Why Two Production Deploy Workflows

| Workflow | Strategy | Speed | Safety | When to Use |
|----------|----------|-------|--------|-------------|
| `deploy-prod.yml` | Rolling update | ~5 min | Good (circuit breaker) | Standard releases |
| `deploy-prod-canary.yml` | Blue/green canary | ~15 min | Maximum (10% exposure) | Risky changes, major versions |

---

## Deployment Strategies Explained

### Rolling Update (What ECS Does by Default)

```
Time 0:  [v1] [v1] [v1]     ← 3 tasks running v1
Time 1:  [v1] [v1] [v1] [v2] ← New v2 task starts (maxPercent=200%)
Time 2:  [v1] [v1] [v2] [v2] ← v2 healthy, one v1 drains
Time 3:  [v1] [v2] [v2] [v2] ← Another v1 drains
Time 4:  [v2] [v2] [v2]      ← All v2, done
```

**Pros:** Fast, simple, no extra infrastructure.
**Cons:** If v2 is broken, users are affected during the rollout. Circuit breaker catches crashes but not subtle bugs.

### Blue/Green with Canary (CodeDeploy)

```
Time 0:  ALB → [Blue TG: v1 v1 v1] (100% traffic)
              [Green TG: empty]

Time 1:  ALB → [Blue TG: v1 v1 v1] (100%)
              [Green TG: v2 v2 v2] ← New tasks launch

Time 2:  ALB → [Blue: 90%] [Green: 10%] ← 10% canary shift

Time 3:  (5 minutes of monitoring...)
         CloudWatch: 5xx? ✗  Latency? ✗  Unhealthy? ✗

Time 4:  ALB → [Blue: 0%] [Green: 100%] ← Full shift

Time 5:  (10 minute buffer — blue still alive for rollback)

Time 6:  Blue tasks terminated. Green IS the new blue.
```

**Pros:** Only 10% of users exposed to potential bugs. Instant rollback. Alarm-driven.
**Cons:** Slower (15-20 min total). Requires two target groups. More complex infrastructure.

---

## Hands-On: Working with Terraform

### Prerequisites

```bash
# Install Terraform
brew install terraform

# Install AWS CLI
brew install awscli

# Configure AWS credentials
aws configure
# Enter: Access Key ID, Secret Key, Region (us-east-1), Output (json)
```

### First Time Setup

```bash
cd infrastructure/terraform/environments/dev

# Create your variables file (NEVER commit this)
cat > terraform.tfvars << EOF
db_username = "churchadmin"
db_password = "YourSecurePassword123!"
jwt_secret  = "your-random-jwt-secret-here"
EOF

# Initialize (downloads AWS provider, configures backend)
terraform init
```

### Common Workflows

```bash
# See what Terraform WOULD do (no changes made)
terraform plan

# Apply changes (creates/updates resources)
terraform apply
# Type 'yes' when prompted

# See current state (what exists)
terraform state list

# See details of a specific resource
terraform state show module.ecs.aws_ecs_service.app

# Destroy everything (WARNING: irreversible)
terraform destroy

# Import an existing resource into state
terraform import 'module.secrets.aws_secretsmanager_secret.database_url' <ARN>

# Target a specific module (only apply changes to VPC)
terraform apply -target=module.vpc
```

### Reading Terraform Plan Output

```
# Resource will be CREATED (new)
  + resource "aws_ecs_service" "app" {
      + name = "church-cms-dev-service"
    }

# Resource will be UPDATED (changed in place)
  ~ resource "aws_ecs_task_definition" "app" {
      ~ cpu = "256" -> "512"
    }

# Resource will be DESTROYED and RECREATED (forces replacement)
-/+ resource "aws_db_instance" "main" {
      ~ identifier = "church-cms-dev-db" (forces replacement)
    }

# Resource will be DESTROYED
  - resource "aws_nat_gateway" "main" {
    }
```

**WARNING:** `-/+` means DESTROY then CREATE. For databases, this means DATA LOSS. Always check plan carefully.

---

## Hands-On: Triggering Deployments

### Deploy to Staging (Automatic)

Just merge to `main`. The staging workflow triggers automatically.

Monitor it:
```bash
# Watch the GitHub Actions run
gh run watch

# Check ECS service status
aws ecs describe-services \
  --cluster church-cms-staging-cluster \
  --services church-cms-staging-service \
  --query 'services[0].{desired:desiredCount,running:runningCount,status:status}'
```

### Deploy to Production (Manual)

```bash
# Standard rolling deploy
gh workflow run deploy-prod.yml \
  -f image_tag=2.1.0 \
  -f confirm=deploy-prod

# Canary deploy (maximum safety)
gh workflow run deploy-prod-canary.yml \
  -f image_tag=2.1.0 \
  -f confirm=canary-prod

# Emergency deploy (skip staging check)
gh workflow run deploy-prod.yml \
  -f image_tag=2.1.0 \
  -f confirm=deploy-prod \
  -f skip_staging_check=true
```

### Rollback

```bash
# ECS circuit breaker handles automatic rollback for crashes.
# For manual rollback, deploy the previous known-good version:
gh workflow run deploy-prod.yml \
  -f image_tag=2.0.0 \
  -f confirm=deploy-prod \
  -f skip_staging_check=true
```

### Viewing Logs After Deploy

```bash
# Real-time logs
aws logs tail /ecs/church-cms-dev --follow

# Logs from last 30 minutes
aws logs tail /ecs/church-cms-dev --since 30m

# Filter for errors only
aws logs filter-log-events \
  --log-group-name /ecs/church-cms-dev \
  --filter-pattern "ERROR"
```

---

## Cost Optimization Decisions

| Decision | Savings | Trade-off |
|----------|---------|-----------|
| NAT Gateway disabled in dev | ~$32/month | ECS tasks get public IPs (less secure) |
| db.t3.micro in dev | ~$15/month vs .small | Less memory, no Performance Insights |
| Single AZ RDS in dev | ~$15/month | No automatic failover |
| 1 ECS task in dev (not 3) | ~$30/month | No HA (single point of failure) |
| Spot instances for EKS staging | ~70% savings | Can be interrupted (2-min warning) |
| Log retention 7 days (dev) | Storage savings | Can't debug old issues |

**Total dev cost: ~$41/month** (vs ~$200/month if using prod settings)

---

## Key Concepts for Interviews

**Q: "Why Terraform over CloudFormation?"**
A: Terraform is cloud-agnostic (works with AWS, GCP, Azure, Kubernetes). CloudFormation is AWS-only. Terraform also has a larger module ecosystem, a more readable HCL syntax, and better state management. Most companies use Terraform unless they're all-in on AWS.

**Q: "How do you handle secrets in Terraform?"**
A: Never in code or state file. We use `terraform.tfvars` (gitignored) for local development and CI/CD variables for automation. Sensitive values are marked with `sensitive = true` so they don't appear in plan output. The actual secrets live in AWS Secrets Manager, not in Terraform state.

**Q: "What happens if Terraform state gets corrupted?"**
A: S3 versioning is enabled. Restore from a previous version: `aws s3api list-object-versions --bucket terraform-state-bucket --prefix dev/terraform.tfstate`. Copy the previous version back. DynamoDB locking prevents concurrent writes that could cause corruption.

**Q: "How do you prevent someone from accidentally destroying production?"**
A: Multiple layers: 1) Separate state files per environment (can't affect prod from dev directory). 2) `deletion_protection = true` on RDS. 3) `prevent_destroy = true` lifecycle on S3 state bucket. 4) Required PR reviews for terraform/ changes. 5) `terraform plan` in CI shows changes before apply.

**Q: "Explain the difference between rolling update and blue/green."**
A: Rolling: gradually replaces old tasks with new ones. Traffic shifts incrementally as new tasks become healthy. Blue/green: runs old AND new simultaneously, then shifts ALL traffic at once (or in a canary pattern). Blue/green is safer (instant rollback) but more expensive (double resources during deploy).

**Q: "What is a Terraform module and why use them?"**
A: A module is a reusable package of resources. Same code, different parameters per environment. Like a function in programming — write once, call many times. Without modules, you'd copy-paste 200 lines of VPC code for each environment and inevitably get drift between them.

**Q: "How does your deployment pipeline prevent bad code from reaching production?"**
A: Progressive confidence gates: CI (lint + test + scan) → Staging auto-deploy → Integration tests → E2E tests → Release (semantic version) → Production manual trigger with staging gate + Cosign signature verification + migration pre-check + post-deploy verification + auto-rollback. Each step must pass before the next.

---

## File Structure

```
infrastructure/terraform/
├── backend/
│   └── main.tf                    ← S3 + DynamoDB for state (one-time setup)
├── modules/
│   ├── vpc/                       ← Network foundation
│   │   ├── main.tf               (VPC, subnets, IGW, NAT, routes)
│   │   ├── variables.tf          (cidr, az_count, enable_nat)
│   │   └── outputs.tf            (vpc_id, subnet_ids)
│   ├── alb/                       ← Load balancer
│   │   ├── main.tf               (ALB, target groups, listeners)
│   │   ├── variables.tf          (port, cert_arn, enable_blue_green)
│   │   └── outputs.tf            (dns_name, tg_arns, listener_arn)
│   ├── ecs/                       ← Compute (Fargate)
│   │   ├── main.tf               (Cluster, task def, service, IAM, SG, HPA)
│   │   ├── variables.tf          (image, cpu, memory, desired_count)
│   │   └── outputs.tf            (cluster_name, service_name, sg_id)
│   ├── rds/                       ← Database
│   │   ├── main.tf               (DB instance, subnet group, SG)
│   │   ├── variables.tf          (instance_class, storage, multi_az)
│   │   └── outputs.tf            (endpoint, connection_string)
│   ├── secrets/                   ← Encrypted credential storage
│   │   ├── main.tf               (Secrets Manager entries)
│   │   ├── variables.tf          (database_url, jwt_secret)
│   │   └── outputs.tf            (secret ARNs)
│   └── codedeploy/                ← Canary deployment (prod only)
│       ├── main.tf               (App, deployment group, alarms, IAM)
│       ├── variables.tf          (strategy, timeouts, cluster/service)
│       └── outputs.tf            (app_name, deployment_group)
├── environments/
│   ├── dev/main.tf                ← Wires modules for dev (cheap, minimal)
│   ├── staging/main.tf            ← Wires modules for staging (mirrors prod)
│   └── prod/main.tf              ← Wires modules for prod (HA, CodeDeploy)
└── .gitignore                     ← Ignores .terraform/, *.tfstate, *.tfvars

.github/workflows/
├── ci.yml                         ← PR gate (lint, test, scan, build)
├── deploy-staging.yml             ← Auto on merge (build → deploy → test)
├── deploy-prod.yml                ← Manual (staging gate → deploy → verify)
├── deploy-prod-canary.yml         ← Manual (CodeDeploy blue/green canary)
├── release.yml                    ← Auto (release-please → version → tag image)
├── security-supply-chain.yml      ← Auto (Trivy IaC + Cosign + SBOM)
└── infracost.yml                  ← PR comment (infrastructure cost estimate)
```
