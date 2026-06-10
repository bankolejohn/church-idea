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

*This section will be added when the `aws-ecs` branch is implemented.*

**Planned architecture:**
- VPC with public/private subnets
- ECS Fargate (serverless containers)
- RDS PostgreSQL (Multi-AZ)
- Application Load Balancer
- CloudWatch (logs, metrics, alarms)
- ECR (container registry)
- Secrets Manager
- Auto Scaling
- WAF

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
