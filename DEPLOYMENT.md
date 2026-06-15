# Deployment Guide

This document covers how to deploy the Church Management System across all environments.
It will be updated as the infrastructure evolves.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development (Docker Compose)](#local-development-docker-compose)
- [AWS ECS Deployment](#aws-ecs-deployment) *(coming soon)*
- [AWS EKS Deployment](#aws-eks-deployment) *(coming soon)*

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

## AWS ECS Deployment

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

- **HTTPS:** Currently HTTP only. To add HTTPS, provision an ACM certificate and add an HTTPS listener to the ALB, then set `ENABLE_HTTPS=true` in the task environment.
- **Secrets:** Never in code or Terraform state committed to git. Use `terraform.tfvars` (gitignored) or pass via CLI.
- **Image:** The CI pipeline pushes to `ghcr.io/bankolejohn/church-idea:develop` on every push to the develop branch.

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
