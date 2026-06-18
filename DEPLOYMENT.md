# Deployment Guide

This document covers how to deploy the Church Management System across all environments.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development (Docker Compose)](#local-development-docker-compose)
- [CI/CD Pipeline Overview](#cicd-pipeline-overview)
- [Deploy to Staging](#deploy-to-staging)
- [Deploy to Production](#deploy-to-production)
- [Semantic Versioning & Releases](#semantic-versioning--releases)
- [AWS ECS Deployment (Infrastructure)](#aws-ecs-deployment)
- [AWS EKS Deployment](#aws-eks-deployment) *(future)*

---

## Prerequisites

- Docker and Docker Compose installed
- Git
- A terminal (Mac/Linux/WSL)

---

## Local Development (Docker Compose)

### First Time Setup

```bash
# Clone the repository
git clone https://github.com/bankolejohn/church-idea.git
cd church-idea

# Create environment files from examples
cp .env.example .env
cp .env.db.example .env.db

# Edit .env and .env.db with your values (or use defaults for local dev)

# Build and start all services
make dev

# Run database migrations (in a separate terminal)
make migrate

# Seed the admin user
make seed
```

The application is now running at `http://localhost:3000`

### Default Credentials

| Role | Username | Password |
|------|----------|----------|
| Main Leader | admin | admin123 |

### Available Commands

| Command | Description |
|---------|-------------|
| `make dev` | Start all services (app + database) with live output |
| `make up` | Start all services in background |
| `make down` | Stop all services |
| `make logs` | View application logs |
| `make migrate` | Run database migrations |
| `make seed` | Seed admin user |
| `make status` | Check health of running services |
| `make build` | Build Docker image only |
| `make clean` | Remove all containers, volumes, and images |

### Architecture (Local)

```
┌────────────────────────────────────────────────┐
│                  localhost                       │
│                                                 │
│  ┌──────────────┐       ┌──────────────────┐   │
│  │   App        │       │   PostgreSQL     │   │
│  │   :3000      │──────►│   :5432          │   │
│  │   (Node.js)  │       │   (postgres:16)  │   │
│  └──────────────┘       └──────────────────┘   │
│                                                 │
└────────────────────────────────────────────────┘
```

### Health Checks

| Endpoint | Purpose | Expected Response |
|----------|---------|-------------------|
| `GET /health` | Liveness probe - is the process alive? | `{"status":"ok"}` |
| `GET /ready` | Readiness probe - can it serve traffic? | `{"status":"ready","database":"connected"}` |

### Environment Variables

All configuration is driven by environment variables. Never hardcode secrets.

| Variable | Description | Required |
|----------|-------------|----------|
| `NODE_ENV` | Environment (development/staging/production) | Yes |
| `PORT` | Application port | Yes |
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `DB_SSL` | Enable SSL for database connection | No (default: false) |
| `DB_POOL_MAX` | Max database connections in pool | No (default: 20) |
| `JWT_SECRET` | Secret key for JWT signing | Yes |
| `ADMIN_PASSWORD` | Initial admin password (seed only) | No |
| `CORS_ORIGIN` | Allowed CORS origins | No (default: *) |
| `LOG_LEVEL` | Logging level (debug/info/warn/error) | No (default: info) |
| `ENABLE_HTTPS` | Enable HSTS and upgrade-insecure-requests headers | No (default: false) |

### Stopping and Restarting

```bash
# Stop everything
make down

# Stop and remove all data (fresh start)
make clean

# Restart just the app (keeps database)
docker compose restart app
```

### Troubleshooting

**Port 3000 already in use:**
```bash
lsof -ti:3000 | xargs kill -9
make dev
```

**Database connection refused:**
```bash
# Check if postgres is healthy
docker compose ps
# If unhealthy, restart
docker compose restart db
# Wait a few seconds, then restart app
docker compose restart app
```

**Need a fresh database:**
```bash
make clean
make dev
make migrate
make seed
```

---

## CI/CD Pipeline Overview

The deployment system uses multiple GitHub Actions workflows working together:

```
PR opened → ci.yml (lint, test, security scan, build)
     │
     ▼
Merged to main → deploy-staging.yml (auto)
     │
     ├── Build & push image to GHCR
     ├── Migration pre-check (DB connectivity + pending migrations)
     ├── Deploy to ECS Fargate
     ├── Integration tests (curl-based, 30s)
     ├── E2E tests (Cypress, Chrome headless)
     └── "Staging Verified" ✅
     │
     ▼
release.yml → release-please opens a Release PR
     │         (bumps version, generates CHANGELOG)
     ▼
Release PR merged → Builds versioned image (e.g., 2.1.0)
     │
     ▼
Manual trigger → deploy-prod.yml
     │
     ├── Validate (confirm intent + image exists)
     ├── Staging gate (verify staging passed for this image)
     ├── Migration pre-check (against prod DB)
     ├── Deploy to ECS Fargate
     ├── Post-deploy integration tests
     └── Auto-rollback on failure
```

### Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | PR + push to main | Lint, test, build, security scan |
| `deploy-staging.yml` | Push to main | Auto-deploy + full test suite |
| `deploy-prod.yml` | Manual (workflow_dispatch) | Production deploy with gates |
| `release.yml` | Push to main | Semantic versioning + changelog |
| `infracost.yml` | PR (terraform changes) | Cost estimation |

### Required GitHub Secrets

Configure these in repo Settings → Secrets and variables → Actions:

| Secret | Environment | Purpose |
|--------|-------------|---------|
| `AWS_ACCESS_KEY_ID` | Both | ECS deploy |
| `AWS_SECRET_ACCESS_KEY` | Both | ECS deploy |
| `STAGING_URL` | staging | Base URL for tests (e.g., `https://staging.example.com`) |
| `STAGING_DATABASE_URL` | staging | Migration pre-check |
| `STAGING_ADMIN_USER` | staging | E2E test login |
| `STAGING_ADMIN_PASS` | staging | E2E test login |
| `PROD_URL` | production | Post-deploy verification |
| `PROD_DATABASE_URL` | production | Migration pre-check |
| `PROD_ADMIN_USER` | production | Post-deploy verification |
| `PROD_ADMIN_PASS` | production | Post-deploy verification |

### GitHub Environments

Create in repo Settings → Environments:

- **staging** — no protection rules (auto-deploys)
- **production** — add required reviewers for the approval gate

---

## Deploy to Staging

Staging deploys **automatically** on every push to `main`. No action required.

### What Happens

1. Docker image built and pushed to GHCR (tagged with SHA + `staging` + `latest`)
2. Migration pre-check verifies DB connectivity and flags pending migrations
3. ECS task definition updated with new image
4. ECS rolling update (waits for service stability, ~3-5 min)
5. Integration tests run against live staging URL
6. Cypress E2E tests verify login, CRUD, security headers
7. Pipeline marked green = safe to promote to production

### Monitoring a Staging Deploy

```bash
# Watch the GitHub Actions run
gh run watch

# Check ECS service status
aws ecs describe-services \
  --cluster church-cms-staging-cluster \
  --services church-cms-staging-service \
  --query 'services[0].{desired:desiredCount,running:runningCount,status:status}'

# View logs
aws logs tail /ecs/church-cms-staging --follow
```

### If Staging Fails

- Check the workflow run for which stage failed
- Integration test failures → API issue (check logs, DB connectivity)
- Cypress failures → check uploaded screenshots/videos in workflow artifacts
- Migration check failure → pending migrations need to be run manually first

---

## Deploy to Production

Production deploys are **manual only** and require the staging pipeline to have passed.

### Prerequisites

1. The staging deploy workflow has passed (green) for the commit you want to deploy
2. You have a version tag (from release-please) or a commit SHA

### Deploy via CLI

```bash
# Deploy a specific semantic version (recommended)
gh workflow run deploy-prod.yml \
  -f image_tag=2.1.0 \
  -f confirm=deploy-prod

# Deploy a specific commit SHA
gh workflow run deploy-prod.yml \
  -f image_tag=abc1234 \
  -f confirm=deploy-prod

# Emergency deploy (skips staging check — use only for hotfixes)
gh workflow run deploy-prod.yml \
  -f image_tag=2.1.1 \
  -f confirm=deploy-prod \
  -f skip_staging_check=true
```

### Deploy via GitHub UI

1. Go to Actions → "Deploy to Production" → "Run workflow"
2. Enter the image tag (version or SHA)
3. Type `deploy-prod` in the confirmation field
4. Click "Run workflow"

### What Happens

1. **Validate** — confirms intent, verifies image exists in GHCR
2. **Staging gate** — queries GitHub API to verify staging passed for this image
3. **Migration check** — verifies prod DB connectivity and checks for pending migrations
4. **Deploy** — ECS rolling update (waits up to 15 min for stability)
5. **Verify** — integration tests run against production URL
6. **Rollback** — if verification fails, auto-reverts to previous task definition

### Rollback (Manual)

If auto-rollback doesn't trigger or you need to manually revert:

```bash
# Force ECS to redeploy the previous stable task definition
aws ecs update-service \
  --cluster church-cms-prod-cluster \
  --service church-cms-prod-service \
  --force-new-deployment

# Or deploy a known good version
gh workflow run deploy-prod.yml \
  -f image_tag=2.0.0 \
  -f confirm=deploy-prod \
  -f skip_staging_check=true
```

---

## Semantic Versioning & Releases

Versions are managed automatically by [release-please](https://github.com/googleapis/release-please).

### How It Works

1. Merge PRs to main using [conventional commits](https://www.conventionalcommits.org/):
   - `fix(auth): handle expired tokens` → patch bump (2.0.0 → 2.0.1)
   - `feat(api): add member search` → minor bump (2.0.0 → 2.1.0)
   - `feat!: rename API endpoints` → major bump (2.0.0 → 3.0.0)
2. release-please opens a "Release PR" accumulating changes
3. When you merge the Release PR, a GitHub Release is created
4. The release workflow builds and tags the image with the version (e.g., `2.1.0`)

### Checking Current Version

```bash
# In package.json
cat package.json | grep version

# Latest release
gh release list --limit 1

# What's running in prod
aws ecs describe-task-definition --task-definition church-cms-prod \
  --query 'taskDefinition.containerDefinitions[0].image'
```

### Configuration Files

| File | Purpose |
|------|---------|
| `.release-please-manifest.json` | Tracks current version |
| `release-please-config.json` | Controls changelog sections, release type |
| `.commitlintrc.json` | Enforces conventional commit format |

---

## Running Tests Locally

### Integration Tests (bash/curl)

```bash
# Against local docker-compose
./scripts/integration-test.sh http://localhost:3000

# Against staging
./scripts/integration-test.sh https://staging.yourapp.com
```

### Cypress E2E Tests

```bash
# Interactive mode (opens browser)
npx cypress open --config baseUrl=http://localhost:3000

# Headless mode (like CI)
npx cypress run --config baseUrl=http://localhost:3000

# Against staging
CYPRESS_BASE_URL=https://staging.yourapp.com npx cypress run
```

### Migration Pre-Check

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/churchdb ./scripts/migrate-check.sh
```

---

## AWS ECS Deployment

> This section covers the **infrastructure** setup. For day-to-day deploys, use the [Deploy to Staging](#deploy-to-staging) and [Deploy to Production](#deploy-to-production) sections above.

### Prerequisites

- AWS CLI installed and configured (`aws configure`)
- Terraform installed (`brew install terraform`)
- AWS account with appropriate IAM permissions
- Docker image built and pushed to GHCR (done automatically by CI pipeline)

### Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           AWS (us-east-1)                              │
│                                                                        │
│  ┌─────────────── VPC (10.0.0.0/16) ──────────────────────────────┐  │
│  │                                                                  │  │
│  │  Public Subnets                    Private Subnets               │  │
│  │  ┌─────────────────┐              ┌─────────────────────────┐   │  │
│  │  │                 │              │                         │   │  │
│  │  │  ALB            │              │  ECS Fargate Tasks      │   │  │
│  │  │  (port 80)      │─────────────►│  (Node.js app:3000)    │   │  │
│  │  │                 │              │                         │   │  │
│  │  └─────────────────┘              │         │               │   │  │
│  │                                    │         ▼               │   │  │
│  │                                    │  ┌─────────────────┐   │   │  │
│  │                                    │  │  RDS PostgreSQL  │   │   │  │
│  │                                    │  │  (port 5432)     │   │   │  │
│  │                                    │  └─────────────────┘   │   │  │
│  │                                    └─────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌────────────────┐  ┌────────────────┐  ┌─────────────────────────┐  │
│  │ Secrets Manager│  │  CloudWatch    │  │  Auto Scaling           │  │
│  │ - DATABASE_URL │  │  - App Logs    │  │  - CPU > 70% → scale up│  │
│  │ - JWT_SECRET   │  │  - Metrics     │  │  - Min: 1, Max: 2 (dev)│  │
│  └────────────────┘  └────────────────┘  └─────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Deployment Steps

```bash
# 1. Navigate to the environment
cd infrastructure/terraform/environments/dev

# 2. Create your variables file
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your actual credentials

# 3. Initialize Terraform
terraform init

# 4. Preview the changes
terraform plan

# 5. Deploy (creates ~35 AWS resources)
terraform apply
# Type 'yes' when prompted. Takes ~7 minutes.

# 6. Run database migrations
SUBNET=$(aws ec2 describe-subnets --filters "Name=tag:Name,Values=church-cms-dev-public-1" --query 'Subnets[0].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups --filters "Name=tag:Name,Values=church-cms-dev-ecs-sg" --query 'SecurityGroups[0].GroupId' --output text)

aws ecs run-task \
  --cluster church-cms-dev-cluster \
  --task-definition church-cms-dev:1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"church-cms-app","command":["sh","-c","node db/migrate.js && node db/seed.js"]}]}'

# 7. Get the application URL
terraform output alb_dns_name
```

### Updating the Application

When new code is pushed and CI builds a new image:

```bash
# Force ECS to pull the latest image
aws ecs update-service \
  --cluster church-cms-dev-cluster \
  --service church-cms-dev-service \
  --force-new-deployment
```

### Viewing Logs

```bash
# View recent logs
aws logs tail /ecs/church-cms-dev --since 30m

# Follow logs in real time
aws logs tail /ecs/church-cms-dev --follow
```

### Checking Service Health

```bash
# Service status
aws ecs describe-services \
  --cluster church-cms-dev-cluster \
  --services church-cms-dev-service \
  --query 'services[0].{desired:desiredCount,running:runningCount,status:status}'

# Hit the health endpoint
curl http://<ALB_DNS>/health
curl http://<ALB_DNS>/ready
```

### Tearing Down (Stop All Charges)

```bash
cd infrastructure/terraform/environments/dev
terraform destroy
# Type 'yes' to confirm. Removes all 35 resources.
```

### Environment Comparison

| Aspect | Dev | Staging | Production |
|--------|-----|---------|------------|
| VPC CIDR | 10.0.0.0/16 | 10.1.0.0/16 | 10.2.0.0/16 |
| Availability Zones | 2 | 2 | 3 |
| NAT Gateway | No (saves $32/mo) | Yes | Yes |
| ECS Tasks | 1 (max 2) | 2 (max 4) | 3 (max 10) |
| ECS Resources | 256 CPU / 512 MB | 512 CPU / 1024 MB | 512 CPU / 1024 MB |
| RDS Instance | db.t3.micro | db.t3.small | db.t3.small |
| Multi-AZ | No | No | Yes |
| Backups | 3 days | 7 days | 30 days |
| Log Retention | 7 days | 14 days | 90 days |
| Deletion Protection | No | No | Yes |
| Estimated Cost | ~$41/month | ~$120/month | ~$200/month |

### Important Notes

- **HTTPS:** ACM certificate is provisioned via Terraform. DNS validation CNAME must be added to your domain registrar. Once validated, ALB serves HTTPS and `ENABLE_HTTPS=true` is set in the ECS task.
- **Secrets:** Never in code or Terraform state committed to git. Use `terraform.tfvars` (gitignored) or pass via CLI.
- **Image:** The CI pipeline pushes to `ghcr.io/bankolejohn/church-idea` with SHA, `staging`, and `latest` tags. Versioned tags (e.g., `2.1.0`) are created by the release workflow.
- **Deploy:** Use the deploy workflows (not manual `aws ecs update-service`) for production changes. The workflows include pre-checks and rollback.

### Known Issues & Solutions

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for detailed resolution of:
- ECS task secret retrieval failures on first deploy
- HSTS/CSP headers breaking HTTP-only deployments
- Database migration execution on ECS

---

## AWS EKS Deployment

*This section will be added when the `aws-k8s` branch is implemented.*

**Planned architecture:**
- EKS managed Kubernetes
- Helm charts
- ArgoCD (GitOps)
- Ingress Controller
- Horizontal Pod Autoscaler
- Cluster Autoscaler / Karpenter
- Prometheus + Grafana
- Service mesh

---

## PWA Installation (End Users)

Once deployed, users can install the app on their phones:

**iPhone (Safari):**
1. Open the app URL in Safari
2. Tap Share → Add to Home Screen

**Android (Chrome):**
1. Open the app URL in Chrome
2. Tap "Install app" banner or Menu → Install app

The app opens in full screen without browser UI.
