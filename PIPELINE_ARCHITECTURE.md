# CI/CD Pipeline Architecture
## Production-Grade Pipeline for Church Management System

---

## Pipeline Philosophy

```
"If it's not automated, it doesn't exist."
"If it's not tested, it's broken."
"If it's not scanned, it's vulnerable."
```

Every line of code goes through the same gauntlet — no shortcuts, no "we'll fix it later."

---

## Git Branching Strategy

```
main (production)
 │
 ├── release/1.2.0 (staging → prod)
 │
 ├── develop (integration branch → auto-deploys to staging)
 │    │
 │    ├── feature/add-member-photo
 │    ├── feature/export-csv
 │    ├── fix/login-timeout
 │    └── hotfix/security-patch
 │
 └── hotfix/critical-fix (emergency → bypasses staging with approval)
```

### Branch Rules

| Branch | Deploys To | Trigger | Protection |
|--------|-----------|---------|------------|
| `feature/*` | Dev (ephemeral) | Push | None |
| `develop` | Staging | Merge/Push | PR required, 1 approval, CI must pass |
| `release/*` | Staging → Prod | Manual tag | PR required, 2 approvals, all checks pass |
| `main` | Production | Merge from release | Protected, no direct push, admin only |
| `hotfix/*` | Prod (fast track) | Manual approval | 2 approvals, all security scans |

---

## Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CI PIPELINE (Every Push/PR)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Lint &  │→ │  Unit    │→ │  Build   │→ │ Security │→ │Integration│   │
│  │  Format  │  │  Tests   │  │  Docker  │  │  Scans   │  │  Tests   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CD PIPELINE - STAGING (On merge to develop)               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Deploy  │→ │  Smoke   │→ │   E2E    │→ │  Perf    │→ │  DAST    │   │
│  │ Staging  │  │  Tests   │  │  Cypress │  │  Tests   │  │  Scan    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│               CD PIPELINE - PRODUCTION (Manual approval required)            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Approval │→ │  Canary  │→ │  Monitor │→ │  Full    │→ │  Post    │   │
│  │  Gate    │  │  Deploy  │  │  5 min   │  │  Rollout │  │  Deploy  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                     │                       │
│                                              ┌──────┴──────┐                │
│                                              │  Auto       │                │
│                                              │  Rollback   │                │
│                                              │  on failure │                │
│                                              └─────────────┘                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## CI PIPELINE (Detailed)

### Stage 1: Code Quality

```yaml
# Runs on: Every push, every PR
# Time: ~2 minutes
# Fail fast: Yes (blocks everything else)

Steps:
  1. Checkout code
  2. Install dependencies (cached)
  3. ESLint (code style + potential bugs)
  4. Prettier (formatting check)
  5. TypeScript check (if applicable)
  6. Commit message lint (conventional commits)
  7. Detect secrets in code (GitLeaks)
```

### Stage 2: Unit & Integration Tests

```yaml
# Runs on: Every push, every PR
# Time: ~3 minutes
# Coverage requirement: 80% minimum

Steps:
  1. Run unit tests (Jest)
  2. Run integration tests (Supertest for API)
  3. Generate coverage report
  4. Upload coverage to Codecov/SonarCloud
  5. Fail if coverage drops below threshold
  6. Fail if any test fails
```

### Stage 3: Build & Package

```yaml
# Runs on: PR and merge to develop/main
# Time: ~3 minutes

Steps:
  1. Build Docker image (multi-stage)
  2. Tag image:
     - PR: ghcr.io/user/church-cms:pr-123
     - Develop: ghcr.io/user/church-cms:staging-abc1234
     - Main: ghcr.io/user/church-cms:1.2.0
  3. Push to container registry (GHCR or ECR)
  4. Generate SBOM (Software Bill of Materials)
  5. Sign image with Cosign
```

### Stage 4: Security Scanning

```yaml
# Runs on: Every push, every PR
# Time: ~5 minutes
# BLOCKING: Critical/High vulnerabilities fail the pipeline

Steps:
  1. SAST - Static Application Security Testing
     - SonarQube or CodeQL (GitHub native)
     - Detects: SQL injection, XSS, insecure crypto, etc.
     
  2. Dependency Scanning
     - npm audit (Node.js dependencies)
     - Snyk or Trivy filesystem scan
     - Detects: Known CVEs in dependencies
     
  3. Container Image Scanning
     - Trivy image scan
     - Detects: OS-level vulnerabilities, misconfigurations
     - Fail on: Critical or High severity
     
  4. Secret Detection
     - GitLeaks or TruffleHog
     - Scans git history for leaked secrets
     - Detects: API keys, passwords, tokens
     
  5. IaC Security Scanning
     - tfsec (Terraform)
     - Checkov (Kubernetes manifests)
     - Detects: Insecure infrastructure configurations
     
  6. License Compliance
     - License Finder
     - Detects: GPL or restricted licenses in dependencies
     
  7. OWASP Dependency Check
     - Cross-references NVD database
     - Detects: Known vulnerable components (OWASP A06)
```

### Stage 5: Integration Tests (Pre-merge)

```yaml
# Runs on: PR only
# Time: ~5 minutes
# Environment: Ephemeral Docker Compose

Steps:
  1. Spin up docker-compose (app + PostgreSQL + Redis)
  2. Run database migrations
  3. Seed test data
  4. Run API integration tests
  5. Test authentication flows
  6. Test authorization (role-based access)
  7. Test database operations
  8. Tear down environment
```

---

## CD PIPELINE - STAGING (Detailed)

### Stage 6: Deploy to Staging

```yaml
# Trigger: Merge to develop branch
# Time: ~3 minutes

Steps:
  1. Pull latest approved image from registry
  2. Update Kubernetes manifests (image tag)
  3. ArgoCD sync (or kubectl apply)
  4. Wait for rollout complete
  5. Verify pods are healthy
  6. Run database migrations (if any)
```

### Stage 7: Smoke Tests

```yaml
# Runs on: After staging deployment
# Time: ~2 minutes
# Purpose: Verify basic functionality works

Steps:
  1. Health check endpoint returns 200
  2. Login endpoint works
  3. Database connection is alive
  4. Static assets are served
  5. API returns expected schema
```

### Stage 8: End-to-End Tests (Cypress)

```yaml
# Runs on: After smoke tests pass
# Time: ~10 minutes
# Environment: Staging with test data

Cypress Test Suites:
  1. Authentication Flow:
     - Admin login
     - Pastor login
     - Invalid credentials rejected
     - Session timeout works
     - Logout clears session
     
  2. Branch Management:
     - Create new branch
     - Edit branch details
     - View branch list
     - Branch appears in dashboard
     
  3. Member Management:
     - Pastor adds member (all fields)
     - Pastor edits member
     - Pastor deletes member
     - Main leader views all members
     - Main leader cannot edit members
     
  4. Access Control:
     - Pastor cannot see other branches
     - Pastor cannot access admin page
     - Main leader sees all branches
     - Unauthenticated user redirected to login
     
  5. Responsive/Mobile:
     - All pages render on mobile viewport
     - Navigation works on mobile
     - Forms are usable on mobile
     - PWA install prompt works
     
  6. Data Integrity:
     - Member count updates correctly
     - Branch filter works
     - Search returns correct results
     - Concurrent edits don't corrupt data
```

### Stage 9: Performance Tests

```yaml
# Runs on: After E2E tests pass
# Time: ~5 minutes
# Tool: k6

Scenarios:
  1. Baseline Load:
     - 50 virtual users
     - 2 minutes duration
     - All endpoints hit
     - Threshold: p95 < 500ms, error rate < 1%
     
  2. Spike Test:
     - Ramp to 200 users in 30 seconds
     - Hold for 1 minute
     - Ramp down
     - Threshold: No 5xx errors, p99 < 2s
     
  3. Soak Test (nightly):
     - 50 users for 30 minutes
     - Monitor memory leaks
     - Monitor connection pool exhaustion
     - Threshold: No degradation over time

Metrics Collected:
  - Request duration (p50, p95, p99)
  - Requests per second
  - Error rate
  - Data transferred
  - Database query time
```

### Stage 10: DAST (Dynamic Application Security Testing)

```yaml
# Runs on: After deployment to staging
# Time: ~15 minutes
# Tool: OWASP ZAP

Scan Types:
  1. Passive Scan:
     - Spider the application
     - Check HTTP headers
     - Check cookie security flags
     - Check CORS configuration
     - Check CSP headers
     
  2. Active Scan:
     - SQL Injection attempts
     - XSS attempts
     - CSRF testing
     - Path traversal
     - Authentication bypass attempts
     - Session fixation
     - Clickjacking
     
  3. API Scan:
     - Test all API endpoints
     - Parameter fuzzing
     - Authentication testing
     - Authorization bypass attempts
     - Rate limit testing

Rules:
  - HIGH findings: Block promotion to prod
  - MEDIUM findings: Warning, require review
  - LOW findings: Informational, track in backlog
```

---

## CD PIPELINE - PRODUCTION (Detailed)

### Stage 11: Approval Gate

```yaml
# Type: Manual approval
# Required approvers: 2 (from CODEOWNERS)
# Includes: Deployment checklist

Checklist (enforced):
  - [ ] All staging tests passed
  - [ ] No critical security findings
  - [ ] Database migration reviewed
  - [ ] Rollback plan documented
  - [ ] On-call engineer notified
  - [ ] Change window confirmed (if applicable)
  - [ ] Customer communication sent (if breaking change)
```

### Stage 12: Canary Deployment

```yaml
# Strategy: Progressive traffic shifting
# Tool: Argo Rollouts or Flagger

Steps:
  1. Deploy new version alongside current (canary)
  2. Route 5% traffic to canary
  3. Monitor for 5 minutes:
     - Error rate (must be < baseline + 0.1%)
     - Latency p99 (must be < baseline + 50ms)
     - No new error types in logs
  4. If healthy: increase to 25%
  5. Monitor for 5 minutes
  6. If healthy: increase to 50%
  7. Monitor for 5 minutes
  8. If healthy: promote to 100%
  
  AUTO-ROLLBACK triggers:
  - Error rate spike > 5%
  - Latency p99 > 2 seconds
  - 5xx responses > 1%
  - Health check failures
  - Memory/CPU spike > 80%
```

### Stage 13: Post-Deployment Verification

```yaml
# Runs on: After full rollout
# Time: ~5 minutes

Steps:
  1. Run production smoke tests
  2. Verify key business flows:
     - Login works
     - Data is accessible
     - New features functional
  3. Check monitoring dashboards:
     - No error rate increase
     - Latency within SLO
     - No resource anomalies
  4. Verify database state:
     - Migrations applied correctly
     - Data integrity maintained
  5. Update deployment record:
     - Version deployed
     - Timestamp
     - Deployer
     - Changelog link
```

### Stage 14: Notification & Documentation

```yaml
# Automatic after successful deployment

Actions:
  1. Slack/Teams notification: "v1.2.0 deployed to production"
  2. Update deployment dashboard
  3. Tag release in GitHub
  4. Generate release notes (from conventional commits)
  5. Update CHANGELOG.md
  6. Close related Jira/GitHub issues
  7. Archive deployment artifacts
```

---

## Deployment Strategies (In Detail)

### Rolling Update (Default)

```
Time ──────────────────────────────────────►

Pod 1: [v1]────────[terminating]─[v2]───────
Pod 2: [v1]─────────────[terminating]─[v2]──
Pod 3: [v1]──────────────────[terminating]─[v2]

Pros: Simple, built into K8s
Cons: Both versions run simultaneously, slow rollback
Use when: Minor updates, non-breaking changes
```

### Blue-Green Deployment

```
         ┌─────────────────┐
Traffic──►│  Load Balancer  │
         └────────┬────────┘
                  │
         ┌────────┴────────┐
         │                  │
    ┌────▼────┐       ┌────▼────┐
    │  BLUE   │       │  GREEN  │
    │  (v1)   │       │  (v2)   │
    │ ACTIVE  │       │ STANDBY │
    └─────────┘       └─────────┘
    
Switch: Instant (change load balancer target)
Rollback: Instant (switch back)

Pros: Zero downtime, instant rollback
Cons: Double infrastructure cost during deploy
Use when: Major releases, database schema changes
```

### Canary Deployment

```
         ┌─────────────────┐
Traffic──►│  Load Balancer  │
         └────────┬────────┘
                  │
         ┌────────┴────────────────┐
         │ 95%                5%   │
    ┌────▼────┐          ┌────▼────┐
    │  STABLE │          │ CANARY  │
    │  (v1)   │          │  (v2)   │
    │ 3 pods  │          │ 1 pod   │
    └─────────┘          └─────────┘
    
Progress: 5% → 25% → 50% → 100%
Each step: Monitor metrics for 5 min
Rollback: Auto on failure, shift 100% back to stable

Pros: Minimal blast radius, data-driven decisions
Cons: Complex setup, requires good monitoring
Use when: Risky changes, new features, performance changes
```

### A/B Testing (Feature Flags)

```
         ┌─────────────────┐
Traffic──►│  Feature Flag   │
         │  Service         │
         └────────┬────────┘
                  │
         ┌────────┴────────┐
         │                  │
    ┌────▼────┐       ┌────▼────┐
    │ Group A │       │ Group B │
    │ Old UI  │       │ New UI  │
    │ 80%     │       │ 20%     │
    └─────────┘       └─────────┘

Pros: User-segment targeting, easy rollback (flip flag)
Cons: Code complexity, flag cleanup needed
Use when: UI changes, feature validation
```

---

## Environment Architecture on GitHub

```
Repository Structure:
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                    # Runs on all PRs
│   │   ├── cd-staging.yml            # Deploys to staging
│   │   ├── cd-production.yml         # Deploys to production
│   │   ├── security-scan.yml         # Nightly full scan
│   │   ├── performance-test.yml      # Nightly perf tests
│   │   ├── dependency-update.yml     # Weekly dependency updates
│   │   └── cleanup.yml               # Prune old images/envs
│   ├── CODEOWNERS                    # Who approves what
│   ├── dependabot.yml                # Auto dependency PRs
│   └── branch-protection.json        # Branch rules as code
├── environments/                      # GitHub Environments config
│   ├── dev.env
│   ├── staging.env
│   └── prod.env
```

### GitHub Environments Configuration

```
┌──────────────────────────────────────────────────────────┐
│                   GitHub Environments                      │
├──────────────┬──────────────────┬────────────────────────┤
│     DEV      │     STAGING      │     PRODUCTION         │
├──────────────┼──────────────────┼────────────────────────┤
│ No approval  │ Auto deploy      │ 2 approvals required   │
│ No wait      │ No wait          │ 15 min wait timer      │
│ Any branch   │ develop only     │ main only              │
│ Ephemeral    │ Persistent       │ Persistent + HA        │
│              │                  │                        │
│ Secrets:     │ Secrets:         │ Secrets:               │
│ - DB_URL     │ - DB_URL         │ - DB_URL               │
│ - JWT_SECRET │ - JWT_SECRET     │ - JWT_SECRET           │
│              │ - MONITORING_KEY │ - MONITORING_KEY        │
│              │                  │ - PAGERDUTY_KEY        │
│              │                  │ - BACKUP_KEY           │
└──────────────┴──────────────────┴────────────────────────┘
```

---

## Security Scanning Matrix

| Scan Type | Tool | When | Blocks Deploy? |
|-----------|------|------|----------------|
| SAST | CodeQL / SonarQube | Every PR | Critical: Yes |
| SCA (Dependencies) | Snyk / npm audit | Every PR | High+: Yes |
| Container Scan | Trivy | After build | Critical: Yes |
| Secret Detection | GitLeaks | Every push | Always: Yes |
| IaC Scan | tfsec / Checkov | PR with infra changes | High+: Yes |
| DAST | OWASP ZAP | After staging deploy | High: Yes |
| License Check | License Finder | Weekly | Restricted: Yes |
| OWASP Top 10 | ZAP + CodeQL | Every PR + staging | Critical: Yes |
| API Security | ZAP API scan | After staging deploy | High: Yes |
| Penetration Test | Manual | Quarterly | N/A (manual) |

### OWASP Top 10 Coverage

| # | Vulnerability | Automated Check | Tool |
|---|--------------|-----------------|------|
| A01 | Broken Access Control | E2E tests + DAST | Cypress + ZAP |
| A02 | Cryptographic Failures | SAST + config scan | CodeQL + Checkov |
| A03 | Injection | SAST + DAST | CodeQL + ZAP |
| A04 | Insecure Design | Architecture review | Manual + threat model |
| A05 | Security Misconfiguration | IaC scan + DAST | tfsec + ZAP |
| A06 | Vulnerable Components | SCA + container scan | Snyk + Trivy |
| A07 | Auth Failures | E2E + DAST | Cypress + ZAP |
| A08 | Data Integrity Failures | SAST + sign verify | CodeQL + Cosign |
| A09 | Logging Failures | Integration tests | Custom checks |
| A10 | SSRF | DAST | ZAP |

---

## Pipeline Quality Gates

### Gate 1: PR Can Be Merged
```
ALL must pass:
  ✅ Code lint clean
  ✅ Unit tests pass (80%+ coverage)
  ✅ No critical SAST findings
  ✅ No high+ dependency vulnerabilities
  ✅ No secrets detected
  ✅ Docker image builds successfully
  ✅ Image scan: no critical vulnerabilities
  ✅ At least 1 reviewer approved
  ✅ Conventional commit format
```

### Gate 2: Can Deploy to Staging
```
ALL must pass:
  ✅ Gate 1 passed
  ✅ Merged to develop branch
  ✅ Image pushed to registry
  ✅ Image signed
  ✅ SBOM generated
```

### Gate 3: Staging Validated
```
ALL must pass:
  ✅ Deployment successful
  ✅ Smoke tests pass
  ✅ E2E tests pass (Cypress)
  ✅ Performance tests within thresholds
  ✅ DAST scan: no high findings
  ✅ No new error patterns in logs
```

### Gate 4: Can Deploy to Production
```
ALL must pass:
  ✅ Gate 3 passed
  ✅ 2 manual approvals
  ✅ Release notes written
  ✅ Rollback plan documented
  ✅ No P1/P2 incidents currently active
  ✅ Within deployment window
  ✅ On-call engineer confirmed
```

### Gate 5: Production Verified
```
ALL must pass:
  ✅ Canary deployment healthy
  ✅ Error rate within SLO
  ✅ Latency within SLO
  ✅ Smoke tests pass on production
  ✅ No customer-reported issues (15 min window)
```

---

## Rollback Procedures

### Automated Rollback (Canary)
```
Trigger: Metric threshold exceeded
Action: Shift 100% traffic back to stable version
Time: < 30 seconds
Human action: None (investigate after)
```

### Manual Rollback (Blue-Green)
```
Trigger: Post-deploy issue discovered
Action: 
  1. Run: kubectl argo rollouts undo <app>
  2. Or: Switch LB target back to blue
Time: < 2 minutes
Human action: Approve rollback, investigate
```

### Database Rollback
```
Trigger: Migration caused data issues
Action:
  1. Run reverse migration
  2. Or: Restore from point-in-time backup
Time: < 15 minutes
Human action: Assess data impact, approve restore
```

### Full Environment Rollback
```
Trigger: Infrastructure-level failure
Action:
  1. Terraform apply previous state
  2. Restore from last known good
Time: < 30 minutes
Human action: Incident commander approval
```

---

## Nightly/Scheduled Pipelines

| Pipeline | Schedule | Purpose |
|----------|----------|---------|
| Full Security Scan | Daily 2 AM | Deep SAST + DAST + full image scan |
| Performance Soak Test | Daily 3 AM | 30-min load test for memory leaks |
| Dependency Update Check | Weekly Mon 9 AM | Check for new versions |
| Backup Verification | Daily 4 AM | Restore backup to temp env, verify |
| Certificate Expiry Check | Daily 6 AM | Alert if certs expire in < 30 days |
| Database Vacuum/Optimize | Weekly Sun 2 AM | DB maintenance |
| Stale Branch Cleanup | Weekly Fri 5 PM | Delete merged branches |
| Cost Report | Weekly Mon 8 AM | Infrastructure cost summary |
| SLO Report | Weekly Mon 8 AM | SLO compliance summary |

---

## Metrics Collected Per Pipeline Run

```yaml
Pipeline Metrics:
  - Total duration
  - Per-stage duration
  - Test pass/fail counts
  - Code coverage percentage
  - Vulnerabilities found (by severity)
  - Image size
  - Deployment duration
  - Time to first request served
  - Rollback count (per week)
  
Team Metrics (tracked over time):
  - Lead time for changes (commit → production)
  - Deployment frequency (deploys per week)
  - Mean time to restore (MTTR)
  - Change failure rate (% of deploys causing incidents)
```

These are the **DORA metrics** — the gold standard for measuring DevOps performance.

---

## Pipeline as Code (Summary)

```
.github/workflows/
│
├── ci.yml
│   └── Trigger: push, pull_request
│   └── Jobs: lint → test → build → scan
│
├── cd-staging.yml
│   └── Trigger: push to develop
│   └── Jobs: deploy → smoke → e2e → perf → dast
│
├── cd-production.yml
│   └── Trigger: manual (workflow_dispatch) OR merge to main
│   └── Jobs: approval → canary → monitor → promote → verify
│
├── security-scan.yml
│   └── Trigger: schedule (daily)
│   └── Jobs: full-sast → full-dast → full-image-scan → report
│
├── performance-test.yml
│   └── Trigger: schedule (nightly)
│   └── Jobs: soak-test → analyze → alert-on-regression
│
├── dependency-update.yml
│   └── Trigger: schedule (weekly)
│   └── Jobs: check-updates → create-pr → run-tests
│
├── backup-verify.yml
│   └── Trigger: schedule (daily)
│   └── Jobs: restore-to-temp → verify-data → cleanup
│
└── cleanup.yml
    └── Trigger: schedule (weekly)
    └── Jobs: prune-images → delete-stale-branches → cost-report
```

---

## Next Step

Ready to start implementing? I suggest we begin with:
1. **ci.yml** — The CI pipeline (lint, test, build, scan)
2. **Cypress test setup** — E2E test suite
3. **docker-compose for testing** — Ephemeral test environments

Tell me when you want to start building these pipelines.
