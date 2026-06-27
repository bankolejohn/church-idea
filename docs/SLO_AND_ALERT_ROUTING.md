# SLOs, Error Budgets & Alert Routing — Deep Dive

This document explains what SLOs are, how error budgets work, and how alerts get routed to Slack/PagerDuty. Includes hands-on exercises.

---

## Table of Contents

1. [What is an SLO?](#what-is-an-slo)
2. [Error Budgets Explained](#error-budgets-explained)
3. [Burn Rate — The Smart Alert](#burn-rate--the-smart-alert)
4. [What We Built](#what-we-built)
5. [How Alert Routing Works (Slack)](#how-alert-routing-works-slack)
6. [Hands-On: Setting Up Slack Integration](#hands-on-setting-up-slack-integration)
7. [Hands-On: Using the SLO Dashboard](#hands-on-using-the-slo-dashboard)
8. [Hands-On: Triggering and Observing Alerts](#hands-on-triggering-and-observing-alerts)
9. [Key Concepts for Interviews](#key-concepts-for-interviews)

---

## What is an SLO?

**SLO = Service Level Objective.** It's a promise about how well your service performs.

| Term | What It Means | Example |
|------|--------------|---------|
| **SLI** (Indicator) | The METRIC you measure | "Percentage of requests that succeed" |
| **SLO** (Objective) | The TARGET for that metric | "99.9% of requests succeed" |
| **SLA** (Agreement) | The CONTRACT with customers (penalties if broken) | "If below 99.9%, customer gets credit" |
| **Error Budget** | How much failure your SLO ALLOWS | "0.1% of requests can fail" |

**Our SLOs:**

| SLO | SLI | Target | Error Budget |
|-----|-----|--------|-------------|
| Availability | % of requests returning non-5xx | 99.9% | 0.1% of requests can fail |
| Latency | % of requests completing < 1 second | 99% | 1% of requests can be slow |

**Why 99.9% and not 100%?**

100% is impossible and counterproductive. Pursuing 100% means:
- You can never deploy (deploys risk errors)
- You can never experiment (experiments might fail)
- You spend infinite money on redundancy

The error budget is your INNOVATION budget. It says: "You have permission to break things 0.1% of the time. Use that budget wisely — ship features, run experiments, take risks. Just don't exceed it."

---

## Error Budgets Explained

### The Math

```
SLO: 99.9% availability over 30 days

Total requests in 30 days (example): 1,000,000
Allowed failures: 1,000,000 × 0.001 = 1,000 requests

If you've used 400 failures by day 15:
  Budget remaining: (1,000 - 400) / 1,000 = 60% remaining
  Status: ON TRACK (healthy pace)

If you've used 900 failures by day 15:
  Budget remaining: (1,000 - 900) / 1,000 = 10% remaining
  Status: BURNING TOO FAST (slow down deploys, investigate)

If you've used 1,000 failures by day 20:
  Budget remaining: 0%
  Status: BUDGET EXHAUSTED (freeze deploys, all hands on stability)
```

### What Happens When Budget is Exhausted

In a real company with SLO discipline:

| Budget Status | Action |
|---------------|--------|
| > 50% remaining | Ship features freely, run experiments |
| 25-50% remaining | Proceed with caution, prioritize reliability |
| < 25% remaining | Feature freeze, focus on stability |
| 0% (exhausted) | Only reliability work until budget replenishes |

This creates a healthy tension: product wants features, SRE wants stability. The error budget is the objective measure that resolves arguments.

---

## Burn Rate — The Smart Alert

### Why Not Just Alert on Error Rate?

If you alert at "error rate > 0.1%" you'll get paged for brief spikes that don't actually matter. A 2-second spike to 0.5% errors doesn't threaten your monthly budget.

**Burn rate** asks a smarter question: "At the CURRENT rate of errors, when will my monthly budget run out?"

### The Math

```
burn_rate = current_error_rate / slo_error_rate

SLO allows: 0.1% errors
Current errors: 1.44% (over the last hour)
Burn rate: 1.44% / 0.1% = 14.4x

Meaning: "You're consuming budget 14.4x faster than sustainable"
At this rate: 30-day budget exhausts in 30/14.4 = ~2 days
```

### Our Alert Thresholds

| Burn Rate | Exhausts Budget In | Alert | Severity |
|-----------|-------------------|-------|----------|
| 14.4x (1h window) | ~2 days | SLOBudgetBurnHigh | Critical |
| 6x (6h window) | ~5 days | SLOBudgetBurnSlow | Warning |

**Why two windows?**
- 1h window catches FAST burns (sudden breakage — deploy went bad)
- 6h window catches SLOW burns (gradual degradation — dependency getting flaky)

The short window fires first for acute problems. The long window catches issues that are too slow for the short window to detect.

---

## What We Built

### 1. SLO Recording Rules (`monitoring/prometheus/rules/slo-recording.yml`)

Pre-computed metrics that power the dashboard:

| Metric | What It Stores |
|--------|---------------|
| `slo:availability:ratio30d` | Current 30-day availability (0.999 = 99.9%) |
| `slo:error_budget_remaining` | Fraction of budget left (1.0 = 100%, 0 = exhausted) |
| `slo:error_ratio:rate1h` | Error ratio over the last hour |
| `slo:error_ratio:rate6h` | Error ratio over the last 6 hours |
| `slo:burn_rate:1h` | 1-hour burn rate (>14.4 = critical) |
| `slo:burn_rate:6h` | 6-hour burn rate (>6 = warning) |
| `slo:latency_good_ratio:rate30d` | % of requests under 1 second (30-day rolling) |
| `slo:latency_budget_remaining` | Latency error budget remaining |

**Why recording rules (not raw queries)?**

Calculating `sum(increase(...[30d]))` on every dashboard refresh is expensive. Recording rules pre-compute it every 30 seconds and store the result as a simple metric. The dashboard just reads the pre-computed value — instant load.

### 2. SLO Dashboard (`monitoring/grafana/dashboards/slo-error-budget.json`)

A dedicated Grafana dashboard with:
- **Availability gauge** (99.9% target — green/yellow/red)
- **Error budget remaining gauge** (percentage left this month)
- **Latency gauge** (99% < 1s target)
- **Burn rate stats** (1h and 6h — current values)
- **Budget consumption over time** (trending graph — is it declining steadily or dropping fast?)
- **Burn rate over time** (are we spending budget evenly or in bursts?)
- **Summary table** (all SLOs at a glance)

### 3. Alertmanager Slack Integration (`monitoring/alertmanager/alertmanager.yml`)

Rewrote the Alertmanager config to route alerts to Slack channels:

| Alert Severity | Slack Channel | Behavior |
|---------------|---------------|----------|
| Critical | `#alerts-critical` | Immediate (10s group wait), repeat every 1h |
| Warning | `#alerts-warning` | 1 minute group wait, repeat every 4h |
| Default | `#alerts` | 30s group wait, repeat every 4h |

Each Slack message includes:
- Alert name and status (FIRING/RESOLVED)
- Summary and description from the alert annotations
- Runbook link (what to do)
- Buttons: "View in Prometheus" and "View Grafana"
- Color coding: red for firing, green for resolved

---

## How Alert Routing Works (Slack)

### The Full Chain

```
Something breaks (e.g., 5xx errors spike)
        │
        ▼
Prometheus evaluates alert rule every 15s
        │ condition true for `for` duration
        ▼
Prometheus sends alert to Alertmanager
        │
        ▼
Alertmanager receives alert
        ├── Checks route tree (what severity?)
        ├── Groups with other active alerts (same alertname)
        ├── Checks inhibition (is there a higher-severity alert?)
        ├── Waits group_wait (batch nearby alerts together)
        │
        ▼
Alertmanager sends Slack notification
        │
        ▼
Slack channel gets a formatted message:
  🚨 HighErrorRate [FIRING]
  Summary: Error rate above 5%
  Description: 8.2% of requests are returning 5xx
  Runbook: Check application logs for stack traces
  [View Prometheus] [View Grafana]
```

### When the Problem Resolves

```
Error rate drops below threshold
        │
        ▼
Prometheus: alert condition no longer true → alert RESOLVES
        │
        ▼
Alertmanager sends resolution notification
        │
        ▼
Slack channel gets:
  🚨 HighErrorRate [RESOLVED]
  (green color bar — it's over)
```

### Grouping (Why You Don't Get Spammed)

Without grouping: 5 pods failing health checks = 5 separate Slack messages.

With grouping (`group_by: ['alertname', 'severity']`):
- All "HighErrorRate" alerts get batched into ONE message
- Alertmanager waits `group_wait` (30s) to collect related alerts
- You get ONE notification listing all affected instances

### Inhibition (Smart Suppression)

If `ServiceDown` (critical) fires, Alertmanager SUPPRESSES `HighLatency` (warning).

Logic: if the service is completely down, obviously latency is bad. Don't send two notifications for the same root cause. Fix the DOWN issue — latency will resolve automatically.

---

## Hands-On: Setting Up Slack Integration

### Option A: Real Slack (Recommended)

**Step 1: Create a Slack App**
1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name: `Church CMS Alerts`, Workspace: your workspace
4. Click "Create App"

**Step 2: Enable Incoming Webhooks**
1. Left sidebar → "Incoming Webhooks"
2. Toggle "Activate Incoming Webhooks" to ON
3. Click "Add New Webhook to Workspace"
4. Select a channel (create `#alerts-test` first)
5. Click "Allow"
6. Copy the Webhook URL (looks like: `https://hooks.slack.com/services/T.../B.../xxx`)

**Step 3: Configure the Environment Variable**
```bash
# Add to your .env file (or export in terminal)
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"

# Restart the monitoring stack
make monitoring-down
make monitoring
```

**Step 4: Test It**
```bash
# Stop the app to trigger ServiceDown alert
docker compose stop app

# Wait 60-90 seconds (alert fires after `for: 1m`)
# Check your Slack channel — you should see a red alert!

# Restart the app
docker compose start app

# Wait 60 seconds — you should see a green "RESOLVED" message
```

### Option B: Without Slack (Local Testing)

If you don't want to set up Slack, alerts still work — they just go to the Alertmanager UI instead of Slack.

1. Check fired alerts: http://localhost:9093/#/alerts
2. Check alert rules: http://localhost:9090/alerts
3. The Slack config degrades gracefully when no webhook URL is set

---

## Hands-On: Using the SLO Dashboard

### Accessing the Dashboard

1. Open Grafana: http://localhost:3001 (admin/admin)
2. Left sidebar → Dashboards → Church CMS folder
3. Click "Church CMS - SLO & Error Budget"

### What You'll See (With Fresh Data)

When you first open it, you might see "No data" or "NaN" — this is because the SLO calculations need a 30-day window of data. For local testing:

**Generate enough data to see values:**
```bash
# Add RATE_LIMIT_LOGIN_MAX=10000 to .env first, then restart app

# Run the smoke test a few times
make load-smoke
make load-smoke
make load-smoke

# Wait 1-2 minutes for Prometheus to scrape and recording rules to evaluate
```

### Reading the Dashboard

**Availability Gauge (top-left):**
- Shows current 30-day availability percentage
- Green (≥99.9%) = meeting SLO
- Yellow (99.8-99.9%) = close to violation
- Red (<99.8%) = SLO violated

**Error Budget Remaining (top-center):**
- 100% = no errors at all (full budget)
- 75% = used 25% of allowed failures
- 0% = budget exhausted (stop shipping, fix stability)

**Burn Rate (middle row):**
- Value of 0 = no errors (perfect)
- Value of 1 = consuming at exactly the sustainable rate
- Value of 14.4 = will exhaust budget in 2 days (CRITICAL)
- Value of NaN = not enough data yet (normal on fresh setup)

**Budget Over Time (bottom-left graph):**
- Should be a FLAT or slowly declining line
- Sudden drops = incident consumed a chunk of budget
- Steady decline = gradual degradation (investigate)

### Simulating an SLO Violation

Want to see the dashboard react? Generate some 5xx errors:

```bash
# Hit a non-existent API endpoint that returns 500 (if you have one)
# Or stop the database briefly to cause errors:
docker compose stop db
sleep 10
docker compose start db

# Watch the burn rate spike and budget decrease
# Refresh the SLO dashboard after 1-2 minutes
```

---

## Hands-On: Triggering and Observing Alerts

### Exercise 1: Trigger ServiceDown Alert

```bash
# 1. Make sure monitoring is running
make monitoring

# 2. Open these in browser tabs:
#    - http://localhost:9090/alerts (Prometheus alerts page)
#    - http://localhost:9093/#/alerts (Alertmanager)
#    - Slack channel (if configured)

# 3. Stop the app
docker compose stop app

# 4. Watch Prometheus alerts page:
#    - ServiceDown goes from "inactive" → "pending" (within 15s)
#    - After 1 minute → "firing" (red)

# 5. Check Alertmanager:
#    - Alert appears with labels and annotations

# 6. Check Slack (if configured):
#    - Red message: 🚨 ServiceDown [FIRING]

# 7. Restart the app
docker compose start app

# 8. Watch alerts resolve:
#    - Prometheus: "firing" → "inactive"
#    - Alertmanager: alert disappears
#    - Slack: green message: 🚨 ServiceDown [RESOLVED]
```

### Exercise 2: Trigger HighLoginFailureRate

```bash
# Generate a bunch of failed logins
for i in $(seq 1 20); do
  curl -s http://localhost:3000/api/login \
    -H "Content-Type: application/json" \
    -d '{"username":"attacker","password":"wrong"}' > /dev/null
done

# Wait 10 minutes (the alert has `for: 10m`)
# Check http://localhost:9090/alerts
# HighLoginFailureRate should go pending → firing
```

### Exercise 3: Observe Alert Grouping

```bash
# Stop both the app AND the database simultaneously
docker compose stop app db

# Watch Alertmanager (http://localhost:9093):
# - ServiceDown fires (critical)
# - HighLatency might fire (warning)
# - But inhibition SUPPRESSES the warning because critical is active
# - You get ONE notification, not two

# Restart everything
docker compose start db
sleep 5
docker compose start app
```

### Exercise 4: Create a Silence (Maintenance Mode)

During planned maintenance, you don't want alerts:

1. Open http://localhost:9093/#/silences
2. Click "New Silence"
3. Set matchers: `alertname = ServiceDown`
4. Set duration: 30 minutes
5. Add comment: "Planned maintenance - restarting app"
6. Click "Create"

Now stop the app — ServiceDown alert fires in Prometheus but Alertmanager SUPPRESSES the notification. No Slack message.

After your maintenance: delete the silence (or let it expire).

---

## Key Concepts for Interviews

**Q: "What's the difference between an SLO and an SLA?"**
A: SLO is internal — your team's reliability target. SLA is external — a contractual agreement with customers that includes penalties. Your SLO should be STRICTER than your SLA. If your SLA is 99.9%, your SLO might be 99.95% — giving you a buffer before you breach the customer agreement.

**Q: "How do you decide what SLO to set?"**
A: Based on user expectations and business impact. A payment processing API needs 99.99% (4 minutes downtime/month). An internal admin tool might only need 99% (7 hours/month). Talk to product and customers: "How much downtime would make you switch to a competitor?" That's your SLO.

**Q: "What happens when you exhaust your error budget?"**
A: In a mature organization: feature freeze. The team shifts from building features to improving reliability until the budget replenishes at the start of the next window. This is enforced through process, not tooling — but the dashboard makes it visible and undeniable.

**Q: "Why use burn rate alerts instead of simple threshold alerts?"**
A: Simple threshold (`error_rate > 1%`) alerts on every brief spike. Most spikes are harmless — they don't threaten the monthly budget. Burn rate asks "will this sustained rate exhaust my budget?" — only alerting when the issue is actually threatening your SLO. Fewer false alerts = more trust in the alerting system = people actually respond when paged.

**Q: "How do you handle alert fatigue?"**
A: 1) Only alert on symptoms that affect users (not causes like "CPU high"). 2) Group related alerts (one notification, not five). 3) Inhibit downstream effects (ServiceDown suppresses HighLatency). 4) Set appropriate `for` durations (brief spikes don't page). 5) Route by severity (critical = page, warning = Slack during business hours). 6) Review and tune regularly (delete alerts nobody acts on).

**Q: "What's the difference between Alertmanager silences and inhibition?"**
A: Silences are manual (you create them for planned maintenance — "don't alert me for 2 hours"). Inhibition is automatic (defined in config — "if ServiceDown fires, suppress HighLatency"). Silences are temporary and human-created. Inhibition rules are permanent and logic-based.

---

## Files Created/Modified

```
monitoring/
├── alertmanager/
│   └── alertmanager.yml           ← REWRITTEN: Slack routing with formatted messages
├── prometheus/rules/
│   ├── alerts.yml                 ← EXISTING: Golden Signals + SLO burn rate alerts
│   └── slo-recording.yml         ← NEW: Pre-computed SLO metrics (30d availability, burn rates)
└── grafana/dashboards/
    └── slo-error-budget.json      ← NEW: SLO dashboard (gauges, burn rates, budget over time)

docker-compose.monitoring.yml      ← MODIFIED: Added SLACK_WEBHOOK_URL env var to alertmanager
```
