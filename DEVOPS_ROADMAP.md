# DevOps Engineering Roadmap
## From "It Works on My Laptop" to Production-Grade SRE

---

## The Philosophy

This isn't a tutorial. It's a simulation of working as a DevOps/SRE engineer at a company.
You'll treat this church management app as if it serves millions of users,
because the patterns are the same whether you serve 200 or 200 million.

**Mindset shift:** You are no longer the developer. You are the engineer responsible for
making sure this application is always available, fast, secure, and recoverable.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        ENVIRONMENTS                          │
├───────────────┬───────────────────┬─────────────────────────┤
│     DEV       │      STAGING      │       PRODUCTION        │
│  (your laptop)│  (mirrors prod)   │   (real users here)     │
│               │                   │                         │
│  docker-compose│  k8s namespace   │   k8s namespace         │
│  hot reload   │  same infra       │   HA + multi-region     │
│  debug tools  │  test data        │   real data             │
│  no TLS       │  TLS + monitoring │   TLS + monitoring +    │
│               │                   │   alerting + on-call    │
└───────────────┴───────────────────┴─────────────────────────┘
```

---

## PHASE 1: Foundation (Weeks 1-2)
### "Make it run properly anywhere"

**Goal:** Containerize, set up environments, establish CI/CD basics.

### 1.1 - Local Development Environment
- [x] Dockerfile created
- [ ] docker-compose.yml for local dev (app + db + monitoring)
- [ ] Hot reload in Docker (nodemon with volume mounts)
- [ ] Environment variable management (.env files per environment)
- [ ] Makefile for common commands

### 1.2 - Database Migration
- [ ] Migrate from SQLite to PostgreSQL (production-ready DB)
- [ ] Database migrations with versioning (using knex or similar)
- [ ] Seed data for dev/staging environments
- [ ] Backup and restore scripts

### 1.3 - Multi-Environment Configuration
- [ ] Environment-specific configs (dev / staging / prod)
- [ ] Secrets management (not hardcoded!)
- [ ] Feature flags (toggle features per environment)
- [ ] Health check endpoint (/health, /ready)

### 1.4 - CI/CD Pipeline (GitHub Actions)
- [ ] Lint + test on every PR
- [ ] Build Docker image on merge to main
- [ ] Push to container registry (Docker Hub or ECR)
- [ ] Auto-deploy to staging on merge
- [ ] Manual approval gate for production
- [ ] Semantic versioning + changelog

**Deliverables:**
- docker-compose.yml (dev)
- .github/workflows/ci.yml
- .github/workflows/deploy.yml
- Makefile
- Health check endpoints

---

## PHASE 2: Infrastructure as Code (Weeks 3-4)
### "Never click a button in a console"

**Goal:** Define ALL infrastructure in code. Reproducible. Version controlled.

### 2.1 - Terraform (Infrastructure)
- [ ] VPC with public/private subnets
- [ ] EKS cluster (or k3s on DigitalOcean for cost)
- [ ] RDS PostgreSQL (or managed DB)
- [ ] S3 bucket for backups
- [ ] IAM roles and policies
- [ ] Terraform state in remote backend (S3 + DynamoDB lock)
- [ ] Terraform modules for reusability
- [ ] Separate state files per environment

### 2.2 - Kubernetes Manifests
- [ ] Namespace per environment (dev, staging, prod)
- [ ] Deployment with resource limits
- [ ] Service (ClusterIP)
- [ ] Ingress with TLS (cert-manager + Let's Encrypt)
- [ ] ConfigMaps and Secrets
- [ ] HPA (Horizontal Pod Autoscaler)
- [ ] PodDisruptionBudget
- [ ] NetworkPolicy

### 2.3 - Helm Charts
- [ ] Package app as Helm chart
- [ ] Values files per environment
- [ ] Dependency management (PostgreSQL subchart)
- [ ] Versioned releases

### 2.4 - GitOps with ArgoCD
- [ ] ArgoCD installed on cluster
- [ ] App of Apps pattern
- [ ] Auto-sync for staging
- [ ] Manual sync for production
- [ ] Rollback capabilities

**Deliverables:**
- terraform/ directory with modules
- k8s/ directory with manifests
- helm/church-cms/ chart
- argocd/ application definitions

---

## PHASE 3: Observability (Weeks 5-6)
### "You can't fix what you can't see"

**Goal:** Full visibility into application and infrastructure health.

### 3.1 - Metrics (Prometheus + Grafana)
- [ ] Prometheus deployed on cluster
- [ ] Application metrics (request count, latency, errors)
- [ ] Node metrics (CPU, memory, disk, network)
- [ ] Custom business metrics (logins, members added, etc.)
- [ ] Grafana dashboards:
  - Application overview
  - Infrastructure health
  - Business KPIs
  - SLO tracking

### 3.2 - Logging (EFK or Loki)
- [ ] Structured JSON logging in application
- [ ] Log aggregation (Loki or EFK stack)
- [ ] Log levels (debug, info, warn, error)
- [ ] Request ID tracing across logs
- [ ] Log retention policies
- [ ] Log-based alerts

### 3.3 - Distributed Tracing (Jaeger or Tempo)
- [ ] OpenTelemetry SDK in application
- [ ] Trace propagation across services
- [ ] Trace-to-log correlation
- [ ] Latency breakdown per endpoint
- [ ] Service dependency graph

### 3.4 - Alerting
- [ ] Alert rules in Prometheus
- [ ] PagerDuty or Opsgenie integration
- [ ] Alert severity levels (P1-P4)
- [ ] Runbooks for each alert
- [ ] On-call rotation (even if it's just you)
- [ ] Incident response playbooks

### 3.5 - SLOs and Error Budgets
- [ ] Define SLIs (latency, availability, error rate)
- [ ] Set SLOs (99.9% availability, p99 < 500ms)
- [ ] Error budget tracking
- [ ] Burn rate alerts
- [ ] SLO dashboard

**Deliverables:**
- monitoring/ directory (Prometheus rules, Grafana dashboards)
- Application instrumented with OpenTelemetry
- Alert rules and runbooks
- SLO definitions

---

## PHASE 4: Security (Weeks 7-8)
### "Assume breach. Defend in depth."

**Goal:** Secure the application, infrastructure, and supply chain.

### 4.1 - Application Security
- [ ] HTTPS everywhere (TLS 1.3)
- [ ] Helmet.js for HTTP headers
- [ ] Rate limiting
- [ ] Input validation and sanitization
- [ ] CORS properly configured
- [ ] Session management hardened
- [ ] SQL injection prevention (parameterized queries)
- [ ] OWASP Top 10 audit

### 4.2 - Infrastructure Security
- [ ] Network policies (deny all, allow specific)
- [ ] Pod security standards (restricted)
- [ ] RBAC (least privilege)
- [ ] Service accounts with minimal permissions
- [ ] Node hardening
- [ ] Private container registry
- [ ] Image scanning (Trivy)
- [ ] Secrets encrypted at rest (Sealed Secrets or Vault)

### 4.3 - Supply Chain Security
- [ ] Dependency scanning (Dependabot / Snyk)
- [ ] Image signing (Cosign)
- [ ] SBOM generation
- [ ] Base image pinning (no :latest)
- [ ] Multi-stage builds (minimal attack surface)

### 4.4 - Compliance and Audit
- [ ] Audit logging (who did what, when)
- [ ] Access reviews
- [ ] Vulnerability management process
- [ ] Security incident response plan

**Deliverables:**
- Security-hardened Dockerfile
- Network policies
- RBAC manifests
- Trivy scanning in CI
- HashiCorp Vault integration (or Sealed Secrets)

---

## PHASE 5: Reliability Engineering (Weeks 9-10)
### "Everything fails. Plan for it."

**Goal:** Zero downtime deployments, automated recovery, chaos testing.

### 5.1 - Deployment Strategies
- [ ] Rolling updates (default K8s)
- [ ] Blue-Green deployment
  - Two identical environments
  - Switch traffic instantly
  - Instant rollback
- [ ] Canary deployment
  - Route 5% traffic to new version
  - Monitor error rates
  - Gradually increase to 100%
  - Auto-rollback on errors
- [ ] Feature flags for dark launches

### 5.2 - High Availability
- [ ] Multi-replica deployment (min 3 pods)
- [ ] Pod anti-affinity (spread across nodes)
- [ ] Database replication (primary + read replicas)
- [ ] Connection pooling (PgBouncer)
- [ ] Circuit breakers
- [ ] Graceful shutdown handling
- [ ] Liveness and readiness probes tuned

### 5.3 - Disaster Recovery
- [ ] Automated database backups (hourly)
- [ ] Point-in-time recovery tested
- [ ] Cross-region backup replication
- [ ] RTO (Recovery Time Objective) defined: < 15 min
- [ ] RPO (Recovery Point Objective) defined: < 1 hour
- [ ] DR drills (monthly)
- [ ] Runbook for full cluster recreation

### 5.4 - Chaos Engineering
- [ ] Chaos Mesh or Litmus installed
- [ ] Experiments:
  - Kill random pods → does it self-heal?
  - Network latency injection → do timeouts work?
  - Node failure → do pods reschedule?
  - Database failover → does app reconnect?
  - DNS failure → does caching help?
- [ ] Game days (scheduled failure injection)
- [ ] Steady state hypothesis for each experiment

### 5.5 - Capacity Planning
- [ ] Load testing (k6 or Locust)
- [ ] Performance baselines established
- [ ] Autoscaling tested under load
- [ ] Resource requests/limits tuned
- [ ] Cost optimization review

**Deliverables:**
- Canary deployment with Flagger or Argo Rollouts
- Chaos experiments defined
- Load test scripts
- DR runbook
- Capacity planning document

---

## PHASE 6: Advanced Operations (Weeks 11-12)
### "Think like a platform team"

**Goal:** Service mesh, multi-region, advanced networking.

### 6.1 - Service Mesh (Istio or Linkerd)
- [ ] Mutual TLS between services
- [ ] Traffic management (retries, timeouts, circuit breaking)
- [ ] Traffic splitting for canary
- [ ] Observability (built-in metrics, tracing)
- [ ] Rate limiting at mesh level

### 6.2 - Multi-Region (Stretch Goal)
- [ ] Active-passive setup
- [ ] Global load balancing (CloudFlare or Route53)
- [ ] Database replication across regions
- [ ] Failover automation
- [ ] Latency-based routing

### 6.3 - Cost Optimization
- [ ] Right-sizing resources
- [ ] Spot instances for non-critical workloads
- [ ] Cluster autoscaler
- [ ] Resource quotas per namespace
- [ ] Cost monitoring (Kubecost)
- [ ] FinOps practices

### 6.4 - Platform Engineering
- [ ] Internal developer platform
- [ ] Self-service environments
- [ ] Golden paths for deployment
- [ ] Documentation as code
- [ ] Backstage catalog (optional)

**Deliverables:**
- Service mesh configuration
- Multi-region architecture diagram
- Cost optimization report
- Platform documentation

---

## Project Structure (Target)

```
church-management-system/
├── app/                        # Application code
│   ├── server.js
│   ├── public/
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── infrastructure/
│   ├── terraform/
│   │   ├── modules/
│   │   │   ├── vpc/
│   │   │   ├── eks/
│   │   │   ├── rds/
│   │   │   └── s3/
│   │   ├── environments/
│   │   │   ├── dev/
│   │   │   ├── staging/
│   │   │   └── prod/
│   │   └── backend.tf
│   └── ansible/               # Configuration management (optional)
├── kubernetes/
│   ├── base/                  # Kustomize base
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   ├── ingress.yaml
│   │   ├── hpa.yaml
│   │   └── kustomization.yaml
│   └── overlays/
│       ├── dev/
│       ├── staging/
│       └── prod/
├── helm/
│   └── church-cms/
│       ├── Chart.yaml
│       ├── values.yaml
│       ├── values-dev.yaml
│       ├── values-staging.yaml
│       ├── values-prod.yaml
│       └── templates/
├── monitoring/
│   ├── prometheus/
│   │   └── rules/
│   ├── grafana/
│   │   └── dashboards/
│   ├── alertmanager/
│   └── loki/
├── security/
│   ├── network-policies/
│   ├── rbac/
│   ├── pod-security/
│   └── sealed-secrets/
├── chaos/
│   ├── experiments/
│   └── game-days/
├── load-testing/
│   ├── k6/
│   └── results/
├── docs/
│   ├── architecture/
│   ├── runbooks/
│   ├── incident-response/
│   └── adr/                   # Architecture Decision Records
├── scripts/
│   ├── setup.sh
│   ├── backup.sh
│   └── restore.sh
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── deploy-staging.yml
│       ├── deploy-prod.yml
│       └── security-scan.yml
├── docker-compose.yml         # Local dev
├── docker-compose.staging.yml
├── Makefile
└── README.md
```

---

## Environment Matrix

| Aspect | Dev | Staging | Production |
|--------|-----|---------|------------|
| **Database** | PostgreSQL (Docker) | PostgreSQL (Managed, small) | PostgreSQL (Managed, HA) |
| **Replicas** | 1 | 2 | 3+ |
| **TLS** | No | Yes (self-signed OK) | Yes (Let's Encrypt) |
| **Monitoring** | Basic (Prometheus local) | Full stack | Full stack + alerting |
| **Logging** | stdout | Loki | Loki + retention |
| **Secrets** | .env file | Sealed Secrets | Vault |
| **Deploys** | Manual (docker-compose) | Auto on merge | Manual approval |
| **Backups** | None | Daily | Hourly + cross-region |
| **Scaling** | None | HPA | HPA + Cluster Autoscaler |
| **Network** | Open | NetworkPolicies | Zero-trust mesh |
| **Chaos** | None | Optional | Scheduled game days |

---

## Tools You'll Learn

| Category | Tool | Why |
|----------|------|-----|
| Containers | Docker, containerd | Foundation of modern infra |
| Orchestration | Kubernetes (k3s → EKS) | Industry standard |
| IaC | Terraform | Multi-cloud, declarative |
| CI/CD | GitHub Actions | Free, integrated |
| GitOps | ArgoCD | Declarative deployments |
| Monitoring | Prometheus + Grafana | Industry standard |
| Logging | Loki | Lightweight, K8s native |
| Tracing | Jaeger / Tempo | Distributed debugging |
| Service Mesh | Istio or Linkerd | Advanced networking |
| Chaos | Chaos Mesh / Litmus | Reliability testing |
| Security | Trivy, Vault, OPA | Defense in depth |
| Load Testing | k6 | Developer-friendly |
| Package | Helm | K8s package management |

---

## Weekly Cadence

**Monday:** Plan what to build/learn this week
**Tue-Thu:** Build, break, fix, document
**Friday:** Write an ADR (Architecture Decision Record) for decisions made
**Weekend:** Read relevant SRE/DevOps content (optional)

---

## Success Metrics (How You Know You're Ready)

- [ ] Can recreate entire infrastructure from code in < 30 minutes
- [ ] Can deploy a new version with zero downtime
- [ ] Can rollback a bad deployment in < 2 minutes
- [ ] Can recover from a database failure in < 15 minutes
- [ ] Can explain every component in the architecture
- [ ] Can identify failures from dashboards before users notice
- [ ] Can handle a 10x traffic spike without manual intervention
- [ ] Has survived at least 3 chaos experiments successfully

---

## Resources

**Books:**
- "Site Reliability Engineering" (Google SRE Book) - free online
- "The Phoenix Project" - DevOps novel
- "Designing Data-Intensive Applications" - systems design

**Practice:**
- Start with Phase 1. Don't skip ahead.
- Each phase builds on the previous.
- Document everything. Future-you will thank present-you.
- Break things intentionally. That's how you learn to fix them.

---

## Next Step

**Start with Phase 1.1:** Set up docker-compose for local development.
Tell me when you're ready and I'll build it with you.
