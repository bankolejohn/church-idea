# Load Testing & Canary Deployments — Deep Dive

This document explains everything about the k6 load testing suite and CodeDeploy canary deployment strategy. Written for learning.

---

## Table of Contents

1. [Why Load Testing Matters](#why-load-testing-matters)
2. [The Four Types of Load Tests](#the-four-types-of-load-tests)
3. [How k6 Works](#how-k6-works)
4. [Running the Tests](#running-the-tests)
5. [Reading k6 Output](#reading-k6-output)
6. [What to Watch in Grafana During Load Tests](#what-to-watch-in-grafana-during-load-tests)
7. [Why Canary Deployments](#why-canary-deployments)
8. [How CodeDeploy Blue/Green Works](#how-codedeploy-bluegreen-works)
9. [The Terraform Infrastructure](#the-terraform-infrastructure)
10. [The Deployment Flow](#the-deployment-flow)
11. [How Rollback Works](#how-rollback-works)
12. [Alertmanager — Completing the Alert Chain](#alertmanager--completing-the-alert-chain)
13. [Key Concepts for Interviews](#key-concepts-for-interviews)

---

## Why Load Testing Matters

Without load testing, you're guessing. You think your app handles 100 users? Prove it. You think it scales? Show the data.

**Real scenarios load testing catches:**
- Database connection pool exhausted at 50 concurrent users (you have 20 max connections)
- Memory leak: heap grows 10MB per hour under sustained traffic → OOM kill after 6 hours
- Login endpoint becomes a bottleneck because bcrypt is CPU-intensive (blocks event loop)
- Rate limiting kicks in too aggressively (legitimate users get 429s)

**When to run load tests:**
- After every significant code change (new query, new middleware)
- Before major releases (is the new feature going to tank performance?)
- After infrastructure changes (smaller instance? fewer connections?)
- Regularly (weekly) to catch gradual degradation

---

## The Four Types of Load Tests

| Type | Purpose | Duration | VUs | When to Use |
|------|---------|----------|-----|-------------|
| **Smoke** | "Does it work at all?" | 30s | 1 | After every deploy |
| **Stress** | "Where does it break?" | 10min | 50→150 | Before releases |
| **Spike** | "Can it handle sudden bursts?" | 5min | 10→200→10 | Capacity planning |
| **Soak** | "Does it leak over time?" | 15min+ | 30 | Weekly/monthly |

### Smoke Test (`make load-smoke`)
One virtual user, 30 seconds. If this fails, something is fundamentally broken. Run this post-deploy as a quick sanity check.

### Stress Test (`make load-stress`)
Ramps up gradually: 50 → 100 → 150 VUs. Finds the breaking point. At what load does latency degrade? At what load do errors appear? Does it recover after the load drops?

### Spike Test (`make load-spike`)
Simulates a sudden burst (10 → 200 VUs in 10 seconds). Tests resilience. Does rate limiting work? Does the DB pool survive? Does the app recover after the spike passes?

### Soak Test (`make load-soak`)
Moderate load (30 VUs) for 15+ minutes. Detects:
- Memory leaks (heap grows, never shrinks)
- Connection leaks (active DB connections climb)
- Gradual latency increase (cache filling up, logs growing)

---

## How k6 Works

k6 is a load testing tool by Grafana Labs. It's written in Go (fast) and scripts are JavaScript (familiar).

**Core concepts:**
- **VU (Virtual User):** One simulated user making requests in a loop
- **Iteration:** One complete run of your test function (a full "user session")
- **Stages:** Define how VUs ramp up/down over time
- **Thresholds:** Pass/fail criteria (if p95 > 2s → test fails)
- **Checks:** Assertions within the test (status == 200?)

**How a VU works:**
```javascript
export default function() {
    // This function runs in a loop for each VU
    // 50 VUs = 50 copies of this function running concurrently
    http.get('http://localhost:3000/api/members');
    sleep(1); // Simulate think time (real users don't click instantly)
}
```

Without `sleep()`, k6 would hammer your server with no pause — unrealistic. Real users read pages, click around, think. `sleep(1)` simulates that.

---

## Running the Tests

```bash
# Prerequisites: app + DB must be running
make dev   # or: make monitoring (includes observability)

# In another terminal:
make load-smoke    # Quick sanity check
make load-stress   # Find limits
make load-spike    # Test resilience
make load-soak     # Detect leaks

# Against staging/production:
k6 run --env BASE_URL=https://staging.example.com load-testing/scripts/stress.js
```

---

## Reading k6 Output

After a run, k6 prints metrics. Here's how to read them:

```
     ✓ login: status 200
     ✓ login: has token
     ✓ branches: status 200

     checks.........................: 98.50%  ✓ 4832  ✗ 73
     data_received..................: 12 MB   198 kB/s
     data_sent......................: 1.2 MB  20 kB/s
     http_req_duration..............: avg=125ms  min=8ms  med=89ms  max=3.2s  p(90)=220ms  p(95)=450ms
     http_req_failed................: 1.50%   ✓ 73    ✗ 4759
     http_reqs......................: 4832    80/s
     iterations.....................: 1208    20/s
     vus............................: 100     min=0   max=150
```

**What matters:**
- `http_req_duration p(95)=450ms` — 95% of requests completed in 450ms or less
- `http_req_failed: 1.50%` — 1.5% of requests returned errors
- `http_reqs: 80/s` — throughput: 80 requests per second sustained
- `checks: 98.50%` — 98.5% of assertions passed

**Thresholds (pass/fail):**
If you defined `thresholds: { http_req_duration: ['p(95)<2000'] }` and p95 was 450ms → PASS. If it was 2100ms → FAIL (exit code 1, CI fails).

---

## What to Watch in Grafana During Load Tests

Run the stress test and open Grafana side by side. Here's what you'll see:

**Application Overview dashboard:**
- Request rate climbs as VUs ramp up (should be proportional)
- Latency: watch if p95/p99 diverge from p50 (sign of queuing)
- Error rate: should stay near 0 until capacity is exceeded

**Infrastructure dashboard:**
- CPU: should climb proportionally with load
- Memory: should stay flat (growth = leak)
- Event loop lag: should stay < 50ms (spikes = blocking operation)
- DB pool: active connections should approach max under peak load
  - If `waiting > 0`, you've hit the pool limit

**Business KPIs dashboard:**
- Login rate spikes (all VUs are logging in)
- Shows the system under realistic usage patterns

---

## Why Canary Deployments

**The problem with rolling updates:**
1. ECS starts replacing old tasks with new ones
2. ALL traffic gradually shifts to new tasks
3. If the new version has a subtle bug (only appears under load), ALL users are affected
4. Circuit breaker detects failures and rolls back — but damage is done

**The canary approach:**
1. New version launches alongside the old one
2. Only 10% of traffic goes to the new version
3. You WATCH for 5 minutes — monitoring error rates, latency, health
4. If anything looks bad → instant rollback. 90% of users never noticed.
5. If everything looks good → shift remaining 90%. Done.

**Why "canary"?**
Named after the canary in the coal mine. Miners sent a canary down first — if it died, they knew the air was toxic. Your 10% traffic is the canary.

---

## How CodeDeploy Blue/Green Works

```
BEFORE DEPLOYMENT:
┌─────────────────────────────────────────────┐
│                    ALB                        │
│            100% traffic                      │
│                 │                            │
│                 ▼                            │
│     ┌────────────────────┐                  │
│     │  Blue Target Group │                  │
│     │  (current version) │                  │
│     │  Tasks: v2.0.0     │                  │
│     └────────────────────┘                  │
│                                              │
│     ┌────────────────────┐                  │
│     │  Green Target Group│                  │
│     │  (empty)           │                  │
│     └────────────────────┘                  │
└─────────────────────────────────────────────┘

DURING CANARY (10% shift):
┌─────────────────────────────────────────────┐
│                    ALB                        │
│         90%              10%                 │
│          │                │                  │
│          ▼                ▼                  │
│     ┌──────────┐    ┌──────────┐            │
│     │  Blue TG │    │ Green TG │            │
│     │  v2.0.0  │    │  v2.1.0  │            │
│     │ (3 tasks)│    │ (3 tasks)│            │
│     └──────────┘    └──────────┘            │
│                                              │
│     ⏱️  Monitoring for 5 minutes...          │
│     📊 CloudWatch: 5xx? Latency? Unhealthy? │
└─────────────────────────────────────────────┘

AFTER SUCCESS (100% shifted):
┌─────────────────────────────────────────────┐
│                    ALB                        │
│            100% traffic                      │
│                 │                            │
│                 ▼                            │
│     ┌────────────────────┐                  │
│     │  Green Target Group│                  │
│     │  (new production)  │                  │
│     │  Tasks: v2.1.0     │                  │
│     └────────────────────┘                  │
│                                              │
│     ┌────────────────────┐                  │
│     │  Blue Target Group │  ← terminating   │
│     │  v2.0.0 (draining) │    after 10min   │
│     └────────────────────┘                  │
└─────────────────────────────────────────────┘
```

---

## The Terraform Infrastructure

### What Was Created

| Resource | Purpose |
|----------|---------|
| `aws_codedeploy_app` | CodeDeploy application (container for deployment groups) |
| `aws_codedeploy_deployment_group` | Defines strategy, alarms, ECS service, target groups |
| `aws_iam_role` (codedeploy) | Permissions for CodeDeploy to manage ECS + ALB |
| `aws_lb_target_group` (green) | Second target group for new version |
| `aws_cloudwatch_metric_alarm` (5xx) | Fires if 5xx errors > 5 in 2 minutes |
| `aws_cloudwatch_metric_alarm` (unhealthy) | Fires if any targets are unhealthy |
| `aws_cloudwatch_metric_alarm` (latency) | Fires if p95 latency > 3 seconds |

### Deployment Configurations Available

| Config Name | Behavior | Best For |
|-------------|----------|----------|
| `ECSAllAtOnce` | Instant switch (0s canary) | Dev/staging, fast feedback |
| `ECSCanary10Percent5Minutes` | 10% → 5min wait → 100% | Production (our choice) |
| `ECSCanary10Percent15Minutes` | 10% → 15min wait → 100% | High-traffic, extra caution |
| `ECSLinear10PercentEvery1Minutes` | 10% → 20% → 30%... every 1min | Gradual, visible shift |
| `ECSLinear10PercentEvery3Minutes` | Same but every 3min | Very cautious, large services |

We chose `ECSCanary10Percent5Minutes` because:
- 10% is enough to detect issues with statistical significance
- 5 minutes gives CloudWatch alarms time to fire (2 evaluation periods × 60s)
- After 5 minutes, we're confident enough to commit

---

## The Deployment Flow

```bash
# Trigger canary deployment
gh workflow run deploy-prod-canary.yml \
  -f image_tag=2.1.0 \
  -f confirm=canary-prod
```

**What happens:**
1. Workflow validates image exists in GHCR
2. Downloads current task definition, swaps image to v2.1.0
3. Registers new task definition revision with ECS
4. Creates CodeDeploy deployment with AppSpec
5. CodeDeploy launches new tasks in green target group
6. Once healthy, shifts 10% traffic to green
7. Monitors CloudWatch alarms for 5 minutes
8. If alarms stay clear → shifts remaining 90%
9. Waits 10 minutes (termination buffer)
10. Terminates old blue tasks

Total time: ~15-20 minutes (compared to 5 minutes for rolling update — safety has a cost)

---

## How Rollback Works

**Automatic rollback triggers:**
1. Any CloudWatch alarm enters ALARM state during the canary window
2. CodeDeploy health checks fail (green tasks not passing health checks)
3. Deployment explicitly fails (ECS can't launch new tasks)

**What happens on rollback:**
- CodeDeploy instantly reroutes ALL traffic back to blue (< 30 seconds)
- Green tasks are terminated
- No manual intervention needed
- GitHub Actions workflow shows "Deployment failed or was rolled back"

**Manual rollback (if needed):**
```bash
# Stop an in-progress deployment
aws deploy stop-deployment --deployment-id d-XXXXXXXXX

# Or deploy the previous known-good version
gh workflow run deploy-prod-canary.yml \
  -f image_tag=2.0.0 \
  -f confirm=canary-prod
```

---

## Alertmanager — Completing the Alert Chain

### The Flow

```
Prometheus (detects problem)
     │
     ▼ fires alert
Alertmanager (decides who to notify)
     │
     ├── Route: severity=critical → immediate notification
     ├── Route: severity=warning → grouped, delayed
     └── Features: deduplication, silencing, inhibition
     │
     ▼ sends notification
Slack / PagerDuty / Email / Webhook
```

### Key Alertmanager Concepts

**Grouping:** If 5 pods all fire "HighMemory" within 30 seconds, you get ONE notification, not 5. The `group_by` setting controls this.

**Inhibition:** If "ServiceDown" fires (critical), suppress "HighLatency" (warning) for the same service. Obviously it's slow — it's DOWN. Don't wake someone up twice.

**Silencing:** During planned maintenance, you create a silence in Alertmanager UI. No alerts fire for the silenced matcher. This prevents false pages during known work.

**Repeat interval:** After sending a notification, Alertmanager waits `repeat_interval` (4 hours) before re-sending for the same alert. Prevents notification spam.

---

## Key Concepts for Interviews

**Q: "What's the difference between blue/green and canary?"**
A: Blue/green is binary — 100% old OR 100% new (with a switchover moment). Canary is gradual — 10% new, then 25%, then 50%, then 100%. Canary is safer because you limit blast radius at each step. Our implementation uses blue/green infrastructure (two target groups) with a canary traffic-shifting strategy (10% first).

**Q: "How do you decide the canary percentage and duration?"**
A: It depends on traffic volume. You need enough traffic hitting the canary to detect statistical anomalies. At 100 req/s, 10% = 10 req/s — enough to detect a 5% error rate increase within a few minutes. At 2 req/s total, 10% is meaningless — you'd need a longer window or higher percentage.

**Q: "What happens if the canary looks good but breaks at 100%?"**
A: This is a real risk. The canary only tests with 10% of traffic — the 100% shift introduces 10x more load on the new version simultaneously. That's why we keep old (blue) tasks alive for 10 minutes after full shift — if issues emerge at full load, we can still roll back instantly.

**Q: "How do you load test without affecting production?"**
A: You don't test IN production. You test in staging with production-like data and config. For production load testing (rare), you use feature flags to shadow traffic — replay real requests against the new version without serving responses to users. Or you run synthetic traffic during low-traffic hours.

**Q: "What's the difference between Prometheus alerting and CloudWatch alarms for canary gates?"**
A: Different purposes. Prometheus alerts monitor the overall service health (ongoing). CloudWatch alarms for CodeDeploy are deployment-specific gates — they only matter during the canary window. If the alarm fires during deployment → rollback. After deployment completes, those alarms still exist but they're separate from Prometheus alerting.

**Q: "Why keep old tasks running after full traffic shift?"**
A: Rollback window. If you terminate blue immediately after shifting to green, and green fails under full load 2 minutes later, you have NO fast rollback path. You'd need to redeploy the old version (build + register + launch = 5+ minutes of downtime). With blue still running, rollback is instant (just re-route traffic back).

---

## Files Created/Modified

```
load-testing/
├── scripts/
│   ├── smoke.js              ← Basic sanity (1 VU, 30s)
│   ├── stress.js             ← Find limits (ramps to 150 VUs)
│   ├── spike.js              ← Sudden burst (10→200 VUs)
│   └── soak.js               ← Leak detection (30 VUs, 15min)

infrastructure/terraform/modules/
├── codedeploy/
│   ├── main.tf               ← CodeDeploy app, deployment group, alarms, IAM
│   ├── variables.tf          ← Config (strategy, timeouts, cluster/service names)
│   └── outputs.tf            ← App name, deployment group name
├── alb/
│   ├── main.tf               ← Added green target group (enable_blue_green)
│   ├── variables.tf          ← Added enable_blue_green variable
│   └── outputs.tf            ← Added green TG outputs, listener ARN, ALB suffix

infrastructure/terraform/environments/prod/
└── main.tf                    ← Added CodeDeploy module, enabled blue_green on ALB

.github/workflows/
└── deploy-prod-canary.yml     ← New workflow: CodeDeploy canary deploy

monitoring/
├── alertmanager/
│   └── alertmanager.yml       ← Alert routing, grouping, inhibition rules
└── prometheus/
    └── prometheus.yml         ← Added alertmanager connection

Makefile                        ← Added load-smoke, load-stress, load-spike, load-soak
docker-compose.monitoring.yml   ← Added Alertmanager service
```
