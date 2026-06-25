# Observability Deep Dive — What, Why, and How

This document explains everything that was done to add observability to the Church CMS project. It's written for learning — so you understand not just the code, but the reasoning behind every decision.

---

## Table of Contents

1. [Why Observability Matters](#why-observability-matters)
2. [The Three Pillars Explained](#the-three-pillars-explained)
3. [What Changed in the Source Code](#what-changed-in-the-source-code)
4. [New Files Created](#new-files-created)
5. [How Each Component Works](#how-each-component-works)
6. [The Data Flow (End to End)](#the-data-flow-end-to-end)
7. [Understanding the Grafana Dashboards](#understanding-the-grafana-dashboards)
8. [Understanding the Alert Rules](#understanding-the-alert-rules)
9. [How to Debug a Production Issue](#how-to-debug-a-production-issue)
10. [Key Concepts for Interviews](#key-concepts-for-interviews)

---

## Why Observability Matters

**The problem:**
In production, you can't `console.log` and stare at a terminal. You can't attach a debugger. You can't reproduce issues on your laptop because they happen under load, with real data, and specific timing conditions.

**Without observability:**
- "The app is slow" → You have no idea why. Is it the DB? The network? A specific route?
- "Users are complaining" → You don't know until they tell you.
- "Something broke last night" → You check logs, but they're unstructured text. You `grep` for hours.

**With observability:**
- Dashboard shows p95 latency spiked at 2:15am
- Drill into the specific route: `/api/members`
- See DB connection pool was exhausted (all 20 connections busy)
- Find the exact trace showing a query that took 8 seconds
- Correlated log shows: "lock wait timeout exceeded"
- Root cause identified in 5 minutes, not 5 hours

---

## The Three Pillars Explained

### Pillar 1: Metrics (Prometheus)

**What:** Numbers that change over time. Stored as time-series data.

**Examples:**
- HTTP requests per second: 150 req/s
- Response time 95th percentile: 230ms
- Database connections active: 12/20
- Memory usage: 340MB

**Why time-series:**
A single number is useless. "Response time is 500ms" — is that good or bad? Was it always 500ms or did it just spike from 50ms? Time-series shows you the TREND.

**How Prometheus works:**
1. Your app exposes metrics at `GET /metrics` in a text format
2. Prometheus PULLS (scrapes) that endpoint every 15 seconds
3. Each scrape becomes a data point in a time-series database
4. You query the data with PromQL (Prometheus Query Language)

**Why pull-based (not push):**
- If your app crashes, Prometheus detects it immediately (scrape fails → `up` metric = 0)
- No registration needed — just configure the target
- Backpressure is natural (Prometheus controls scrape rate)

---

### Pillar 2: Logs (Loki)

**What:** Timestamped text records of what happened in the application.

**Why structured (JSON):**
```
# Bad (unstructured):
2024-01-15 14:30:22 ERROR User login failed for admin from 192.168.1.1

# Good (structured JSON):
{"level":"error","message":"Failed login attempt","username":"admin","ip":"192.168.1.1","timestamp":"2024-01-15T14:30:22Z","trace_id":"abc123","requestId":"req-456"}
```

The structured version lets you:
- Filter: `| json | level="error"` → only errors
- Search: `| json | username="admin"` → specific user's activity
- Aggregate: count errors per minute
- Correlate: `trace_id` links to the full trace in Jaeger

**Why Loki (not Elasticsearch/EFK):**
- Loki only indexes LABELS, not the full text → much cheaper to run
- Same query language style as Prometheus (LogQL ≈ PromQL)
- Native Grafana integration (one dashboard tool for everything)
- In our setup it costs $0 (runs in Docker)

---

### Pillar 3: Traces (OpenTelemetry → Jaeger)

**What:** The complete journey of a single request through your system.

**Example trace for `POST /api/login`:**
```
[Span 1] HTTP POST /api/login (total: 45ms)
  └── [Span 2] Express middleware (2ms)
  └── [Span 3] PostgreSQL: SELECT * FROM users WHERE username = $1 (12ms)
  └── [Span 4] bcrypt.compare (28ms)
  └── [Span 5] jwt.sign (3ms)
```

Each "span" tells you: what operation, how long, whether it succeeded or failed.

**Why traces matter:**
- Metrics tell you "requests are slow"
- Traces tell you "this specific request was slow because the DB query took 8 seconds because it did a full table scan"

**OpenTelemetry (OTel):**
OTel is the CNCF standard. It replaces vendor-specific SDKs (Datadog agent, New Relic agent, etc.) with one unified API. You instrument once, and can send data to ANY backend (Jaeger, Tempo, Datadog, Honeycomb...).

---

## What Changed in the Source Code

### Modified Files

| File | What Changed | Why |
|------|-------------|-----|
| `server.js` | Added `require('./lib/telemetry')` at the very top | OTel must load FIRST to patch modules before they're imported |
| `server.js` | Added `require('./lib/metrics')` | Import the metrics module |
| `server.js` | Added `app.use(metrics.httpMiddleware)` | Records request duration/count for every HTTP request |
| `server.js` | Added `app.get('/metrics', metrics.metricsEndpoint)` | Exposes Prometheus scrape endpoint |
| `server.js` | Added `metrics.loginAttemptsTotal.inc(...)` in login route | Tracks business metric: login success/failure |
| `server.js` | Added `metrics.membersCreatedTotal.inc(...)` in member routes | Tracks business metric: member operations |
| `server.js` | Added `metrics.trackPool(db.pool)` in startServer | Monitors DB connection pool health |
| `lib/logger.js` | Complete rewrite | Added trace_id/span_id injection, structured JSON output |
| `package.json` | Added OpenTelemetry and prom-client dependencies | New npm packages |
| `docker-compose.yml` | Added OTel environment variables | Configures telemetry when running in Docker |
| `Makefile` | Added `monitoring` and `monitoring-down` targets | Convenience commands |

### Key Insight: Why Telemetry Must Load First

```javascript
// server.js — Line 1 (BEFORE all other requires)
require('./lib/telemetry');

// Why? Because OpenTelemetry works by MONKEY-PATCHING Node modules.
// When you later do: const express = require('express')
// OTel has already wrapped Express's internal functions.
// If you load Express BEFORE OTel, the patching misses it.
```

This is the most common mistake people make with OTel in Node.js.

---

## New Files Created

### `lib/telemetry.js` — OpenTelemetry SDK Setup

**Purpose:** Initialize distributed tracing and auto-instrumentation.

**What it does:**
1. Creates a "Resource" (identifies your service: name, version, environment)
2. Configures an OTLP trace exporter (sends traces to Jaeger/Tempo)
3. Configures a Prometheus metrics exporter (separate port 9464)
4. Loads auto-instrumentations that patch Express, pg, HTTP, Winston
5. Starts the SDK

**Auto-instrumented modules:**
- `express` → creates spans for each route handler
- `pg` (PostgreSQL) → creates spans for each query (includes SQL text)
- `http/https` → creates spans for outgoing HTTP calls
- `winston` → injects trace_id into log entries
- `dns` → tracks DNS lookup time

**What we disabled:**
- `fs` instrumentation (too noisy — creates spans for every file read)
- `net` instrumentation (low-level socket noise)
- Health/metrics/ready endpoints (excluded from tracing to reduce noise)

---

### `lib/metrics.js` — Prometheus Custom Metrics

**Purpose:** Define and expose application-specific metrics.

**Metric types used:**

| Type | Behavior | Example |
|------|----------|---------|
| Counter | Only goes UP (ever-increasing) | `http_requests_total` — counts every request |
| Gauge | Goes up AND down | `db_pool_active_connections` — current count |
| Histogram | Measures distribution in buckets | `http_request_duration_seconds` — latency |

**Why histograms for latency (not averages):**
An average hides problems. If 99 requests take 50ms and 1 takes 10 seconds, the average is 149ms — looks fine! But one user waited 10 seconds.

Histograms let you calculate percentiles:
- p50 (median): 50ms — "typical" experience
- p95: 200ms — most users see this or better
- p99: 2s — 1% of users are suffering

**The HTTP middleware pattern:**
```javascript
function httpMiddleware(req, res, next) {
    const start = process.hrtime.bigint();  // Start timer
    httpActiveRequests.inc();                 // Track in-flight

    res.on('finish', () => {                 // When response sent:
        const duration = ...;                // Calculate elapsed time
        httpRequestDuration.observe(...);     // Record in histogram
        httpRequestsTotal.inc(...);          // Increment counter
        httpActiveRequests.dec();            // Decrement in-flight
    });

    next();  // Don't block the request
}
```

This pattern is non-intrusive: the middleware doesn't slow down or modify the response. It just observes.

**Label cardinality warning:**
Labels create unique time-series. If you label by `user_id`, and you have 10,000 users, you get 10,000 separate time-series. Prometheus will choke.

That's why we normalize routes: `/api/members/42` → `/api/members/:id`. Otherwise every unique member ID creates a new series.

---

### `lib/logger.js` — Structured Logger with Trace Correlation

**Purpose:** Connect logs to traces. See an error in Loki → click → see the trace in Jaeger.

**The key innovation — trace context injection:**
```javascript
const traceContextFormat = winston.format((info) => {
    const span = trace.getSpan(context.active());
    if (span) {
        info.trace_id = spanContext.traceId;
        info.span_id = spanContext.spanId;
    }
    return info;
});
```

This custom Winston format reaches into OTel's context and extracts the current trace/span IDs. Every log entry automatically gets them. No manual work required.

**Output in production (JSON):**
```json
{
  "level": "info",
  "message": "User logged in",
  "username": "admin",
  "timestamp": "2024-01-15T14:30:22.000Z",
  "service": "church-cms",
  "environment": "production",
  "trace_id": "abc123def456",
  "span_id": "789xyz",
  "requestId": "req-001"
}
```

Loki parses this JSON automatically (configured in promtail.yml). You can then:
- Filter: `{service="church-cms"} | json | level="error"`
- Click the `trace_id` → opens in Jaeger

---

### `docker-compose.monitoring.yml` — The Monitoring Stack

**Purpose:** Run the entire observability stack locally with one command.

**Services:**

| Service | Image | Port | Role |
|---------|-------|------|------|
| prometheus | prom/prometheus:v2.53.0 | 9090 | Scrapes /metrics, stores time-series, evaluates alerts |
| grafana | grafana/grafana:11.1.0 | 3001 | Dashboards for metrics, logs, and traces |
| loki | grafana/loki:3.1.0 | 3100 | Log storage (queried by Grafana) |
| promtail | grafana/promtail:3.1.0 | — | Ships Docker container logs to Loki |
| jaeger | jaegertracing/all-in-one:1.58 | 16686, 4318 | Receives traces via OTLP, provides trace UI |

**Why separate from docker-compose.yml:**
- You don't always want the monitoring stack running (it uses resources)
- In production, monitoring is a separate concern (different team, different infrastructure)
- Separation lets you restart the app without losing monitoring state

---

### `monitoring/prometheus/prometheus.yml` — Scrape Configuration

**What it configures:**
```yaml
scrape_configs:
  - job_name: 'church-cms'        # Scrape our app's /metrics
    targets: ['app:3000']

  - job_name: 'church-cms-otel'   # Scrape OTel's Prometheus exporter
    targets: ['app:9464']

  - job_name: 'prometheus'        # Prometheus monitors itself
    targets: ['localhost:9090']
```

**Why two scrape targets for the app:**
- Port 3000 `/metrics` → our custom prom-client metrics (HTTP, business, DB pool)
- Port 9464 → OpenTelemetry's built-in Prometheus exporter (runtime metrics from OTel SDK)

---

### `monitoring/prometheus/rules/alerts.yml` — Alerting Rules

**How alerts work:**
1. Prometheus evaluates rules every 15 seconds
2. If condition is true for the `for` duration → alert FIRES
3. Alert goes to Alertmanager (routes to Slack, PagerDuty, email)
4. When condition resolves → alert RESOLVES

**The `for` clause prevents flapping:**
Without it: CPU hits 81% for 1 second → alert → resolves → alerts again → resolves. Your phone buzzes all night.
With `for: 5m`: CPU must be >80% for 5 CONTINUOUS minutes before alerting. Brief spikes are ignored.

**SLO burn rate alerts explained:**
If your SLO is 99.9% availability (error budget = 0.1% of requests can fail):
- Monthly budget: ~43 minutes of downtime
- Burn rate 14.4x: consuming budget 14.4x faster than planned → exhausts in 3 days
- Burn rate 6x: consuming 6x faster → exhausts in 7 days

These alerts catch slow-bleed issues that individual metric alerts miss.

---

### `monitoring/loki/loki.yml` — Log Storage Configuration

**Key settings:**
- `retention_period: 168h` — keeps 7 days of logs in dev (saves disk)
- `schema: v13` — latest storage format (TSDB-based, efficient)
- `replication_factor: 1` — single instance (production would use 3+)

---

### `monitoring/promtail/promtail.yml` — Log Shipper Configuration

**How Promtail discovers containers:**
```yaml
docker_sd_configs:
  - host: unix:///var/run/docker.sock  # Reads Docker API
```

It automatically finds all containers in the compose project and reads their stdout/stderr logs.

**Pipeline stages (log processing):**
```yaml
pipeline_stages:
  - json:              # Parse JSON fields from the log line
      expressions:
        level: level
        message: message
  - labels:            # Promote 'level' to a Loki label
      level:
  - timestamp:         # Use the log's timestamp, not ingestion time
      source: timestamp
```

This means you can filter in Grafana by log level: `{level="error"}` — fast and indexed.

---

### Grafana Dashboard Files (`monitoring/grafana/dashboards/*.json`)

**Why JSON files (not manual creation):**
- Reproducible: `make monitoring` gives everyone the same dashboards
- Version controlled: dashboard changes are visible in git diffs
- No manual clicks: new team members get full observability instantly

**How auto-provisioning works:**
1. `monitoring/grafana/provisioning/dashboards/dashboards.yml` tells Grafana where to find JSON files
2. `monitoring/grafana/provisioning/datasources/datasources.yml` pre-configures Prometheus, Loki, and Jaeger
3. On startup, Grafana reads these and creates everything automatically

---

## The Data Flow (End to End)

```
User makes request: POST /api/login
        │
        ▼
[OpenTelemetry starts a trace — assigns trace_id: abc123]
        │
        ▼
[Express middleware — metrics.httpMiddleware records start time]
        │
        ▼
[Route handler executes — login logic runs]
        │
        ├── logger.info("User logged in") 
        │     └── Winston adds: trace_id=abc123, span_id=xyz
        │     └── stdout → Promtail → Loki
        │
        ├── db.query("SELECT * FROM users")
        │     └── OTel auto-creates a DB span (12ms, SQL attached)
        │     └── Span sent to Jaeger via OTLP
        │
        ├── metrics.loginAttemptsTotal.inc({status: "success"})
        │     └── Counter incremented in memory
        │     └── Next Prometheus scrape picks it up
        │
        └── Response sent (200 OK)
              └── httpMiddleware records: duration=45ms, route=/api/login, status=200
              └── Histogram + Counter updated
              └── Next Prometheus scrape picks it up
```

**15 seconds later — Prometheus scrapes /metrics:**
- Sees: `churchcms_http_requests_total{route="/api/login",status_code="200"} 1`
- Sees: `churchcms_http_request_duration_seconds_bucket{le="0.05",...} 1` (45ms fits in the 50ms bucket)
- Stores as time-series data point

**In Grafana:**
- Application dashboard shows: request rate +1, latency p50 = 45ms
- Business dashboard shows: successful logins +1

**If something goes wrong:**
- Alert rule checks: `error_rate > 5%` → fires if true for 3 minutes
- You open Loki: see the error log with trace_id
- Click trace_id → Jaeger shows which span failed and why

---

## Understanding the Grafana Dashboards

### Dashboard 1: Application Overview

**Who looks at this:** On-call engineers, SREs

**Panels:**
- **Request Rate** — Are we serving traffic? Sudden drop = outage. Sudden spike = possible attack.
- **Response Time (p50/p95/p99)** — Is the app fast? p95 > 1s = users are frustrated.
- **Error Rate** — Are requests failing? > 1% = something is wrong.
- **Uptime** — Is Prometheus able to reach the app?
- **Requests by Route** — Which endpoints are hot? Which are failing?
- **Response Codes pie** — Quick visual: mostly 200s? Any 5xx cluster?

### Dashboard 2: Infrastructure

**Who looks at this:** DevOps engineers investigating resource issues

**Panels:**
- **CPU** — Is the process compute-bound? > 80% = might need to scale.
- **Memory (RSS + Heap)** — Is there a memory leak? Growing over time = leak.
- **Event Loop Lag** — Is the main thread blocked? > 100ms = blocking operation somewhere.
- **DB Connection Pool** — Are we running out of connections? Waiting > 0 = queries are queuing.
- **GC Duration** — Is garbage collection pausing the app? Long pauses = allocating too many objects.

### Dashboard 3: Business KPIs

**Who looks at this:** Product managers, team leads

**Panels:**
- **Login Activity** — Are users actively using the system?
- **Login Success Rate** — Is auth working? Sudden drop = broken auth.
- **Members Created** — Is the church growing? Are pastors using the system?
- **By Branch** — Which branches are most active?

---

## Understanding the Alert Rules

### The Golden Signals Framework

Google's SRE team identified four signals that matter for every service:

| Signal | Question | Our Alert |
|--------|----------|-----------|
| Latency | How fast? | p95 > 2s, p99 > 5s |
| Traffic | How much demand? | (covered by dashboards) |
| Errors | How many failures? | > 5%, > 25% |
| Saturation | How full are resources? | Memory > 450MB, DB pool exhausted |

### Severity Levels

| Level | Meaning | Response |
|-------|---------|----------|
| Critical | Users are impacted NOW | Page on-call immediately |
| Warning | Will become critical if not addressed | Investigate within hours |
| Info | Noteworthy but not urgent | Review next business day |

### Why Each Alert Exists

**ServiceDown** — The most basic: is the app running at all?

**HighLatencyP95** — Users are waiting too long. Not critical yet (p99 might still be ok), but degrading.

**DatabasePoolExhausted** — This causes cascading failure. If all connections are busy, new requests queue up, latency spikes, timeouts fire, error rate climbs. Catching this EARLY prevents the cascade.

**SLO Burn Rate** — The most sophisticated alert. Instead of alerting on absolute values, it alerts on the RATE at which you're consuming your error budget. This catches slow degradation that individual alerts miss.

---

## How to Debug a Production Issue

**Scenario: "The app is slow for some users"**

Step 1: Open Grafana → Application Overview
- Look at p95 and p99. If p50 is fine but p99 is high, the issue affects a subset of requests.

Step 2: Check "Requests by Route"
- Identify which route is slow. Example: `/api/members` has high latency.

Step 3: Open Infrastructure dashboard
- Check DB pool. If `waiting_clients > 0`, connections are saturated.
- Check event loop lag. If > 100ms, something is blocking.

Step 4: Open Loki (Explore → Loki datasource)
- Query: `{service="church-cms"} | json | level="error"`
- Look for errors correlated with the time of slowness.

Step 5: Find a trace
- From a log entry, grab the `trace_id`
- Open Jaeger → Search by trace ID
- See the full breakdown: which span is taking the longest?

Step 6: Root cause identified
- Example: The PostgreSQL span shows 8 seconds for `SELECT * FROM members WHERE branch_id = $1`
- The `branch_id` column doesn't have an index. Full table scan under load.

Step 7: Fix
- Add the index, deploy, watch the dashboard show latency drop.

---

## Key Concepts for Interviews

**Q: "What's the difference between monitoring and observability?"**
A: Monitoring is checking known things (is CPU > 80%? Is the service up?). Observability lets you answer questions you didn't predict. With good observability, you can debug issues you've never seen before by exploring metrics, logs, and traces together.

**Q: "Why not just use CloudWatch?"**
A: CloudWatch is fine for basic metrics and logs. But it doesn't give you distributed tracing, log-to-trace correlation, or custom dashboards with sub-second granularity. For a mature platform, you need the three pillars working together. Plus, Prometheus/Grafana/Loki are cloud-agnostic — they work the same on AWS, GCP, or on-prem.

**Q: "How do you decide what to alert on?"**
A: Alert on SYMPTOMS, not causes. Don't alert "CPU is high" — alert "response time is high." Users don't care about CPU. They care about the experience. CPU alerts are useful as secondary investigation, not as primary pages.

**Q: "What's an SLO and why does it matter?"**
A: SLO = Service Level Objective. It's a promise: "99.9% of requests will succeed." The error budget (0.1%) is your innovation budget — you can break things 0.1% of the time. Burn rate alerts tell you when you're spending that budget too fast.

**Q: "How do you handle high-cardinality labels?"**
A: Never use unbounded values as labels (user_id, request_id, email). These create millions of time-series and crash Prometheus. Instead, use bounded labels (status_code, route, method, environment). Put high-cardinality data in logs, not metrics.

---

## NPM Packages Added

| Package | Purpose |
|---------|---------|
| `@opentelemetry/sdk-node` | Core OTel SDK for Node.js |
| `@opentelemetry/api` | OTel API (trace context access) |
| `@opentelemetry/auto-instrumentations-node` | Auto-patches Express, pg, HTTP, etc. |
| `@opentelemetry/exporter-trace-otlp-http` | Sends traces to OTLP collector |
| `@opentelemetry/exporter-metrics-otlp-http` | Sends metrics to OTLP collector |
| `@opentelemetry/exporter-prometheus` | Exposes OTel metrics for Prometheus scraping |
| `@opentelemetry/sdk-metrics` | Metrics SDK |
| `@opentelemetry/resources` | Service identification (name, version) |
| `@opentelemetry/semantic-conventions` | Standard attribute names |
| `prom-client` | Prometheus client library for custom metrics |

---

## File Tree (New/Modified)

```
church-idea/
├── lib/
│   ├── telemetry.js          ← NEW: OpenTelemetry SDK initialization
│   ├── metrics.js            ← NEW: Prometheus custom metrics + middleware
│   └── logger.js             ← MODIFIED: trace_id injection, structured JSON
├── server.js                  ← MODIFIED: telemetry require, metrics middleware, /metrics endpoint
├── package.json               ← MODIFIED: new dependencies
├── docker-compose.yml         ← MODIFIED: OTel env vars for app service
├── docker-compose.monitoring.yml ← NEW: full monitoring stack
├── Makefile                   ← MODIFIED: monitoring commands
└── monitoring/
    ├── prometheus/
    │   ├── prometheus.yml     ← NEW: scrape config
    │   └── rules/
    │       └── alerts.yml     ← NEW: alerting rules (Golden Signals + SLO)
    ├── grafana/
    │   ├── dashboards/
    │   │   ├── application-overview.json  ← NEW
    │   │   ├── infrastructure.json        ← NEW
    │   │   └── business-kpis.json         ← NEW
    │   └── provisioning/
    │       ├── dashboards/dashboards.yml  ← NEW: auto-load dashboards
    │       └── datasources/datasources.yml ← NEW: pre-configure data sources
    ├── loki/
    │   └── loki.yml           ← NEW: log storage config
    └── promtail/
        └── promtail.yml       ← NEW: Docker log shipping config
```

---

## What's Next

With observability in place, you can now:
1. **Set up real SLOs** and track error budgets in Grafana
2. **Add Alertmanager** to route alerts to Slack/PagerDuty
3. **Add load testing (k6)** and watch the dashboards under stress
4. **Move to Kubernetes** where Prometheus/Grafana/Loki deploy as Helm charts
5. **Add Tempo** (Grafana's tracing backend) to replace Jaeger for better Grafana integration

This is the foundation of professional SRE work. Everything from here is refinement.


---

## Hands-On: Using the Monitoring Stack (Step by Step)

This section is for anyone who has never used Prometheus, Grafana, Loki, or Jaeger before. Follow along from the start.

---

### Step 1: Start Everything

```bash
# Make sure Docker is running, then:
make monitoring
```

This starts: your app + PostgreSQL + Prometheus + Grafana + Loki + Promtail + Jaeger + Alertmanager.

Wait about 30 seconds for all services to be healthy. You'll see logs scrolling in the terminal.

**Verify everything is up:**

| Service | URL | What You Should See |
|---------|-----|---------------------|
| App | http://localhost:3000 | Church CMS login page |
| App metrics | http://localhost:3000/metrics | Wall of text (Prometheus format) |
| Grafana | http://localhost:3001 | Login page (admin/admin) |
| Prometheus | http://localhost:9090 | Prometheus query UI |
| Jaeger | http://localhost:16686 | Jaeger search page |
| Alertmanager | http://localhost:9093 | Alertmanager status page |

If any of these don't load, check `docker compose ps` to see which container is unhealthy.

---

### Step 2: Generate Traffic (So the Tools Have Data)

Open a NEW terminal window and run these commands:

```bash
# Seed the database (creates admin user)
make seed

# Login and get a token
TOKEN=$(curl -s http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Verify token worked
echo "Token: ${TOKEN:0:20}..."

# Hit all the major endpoints
curl -s http://localhost:3000/health
curl -s http://localhost:3000/ready
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/branches
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/members
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/stats

# Generate some failed logins (shows up in dashboards)
curl -s http://localhost:3000/api/login -H "Content-Type: application/json" -d '{"username":"hacker","password":"wrong"}'
curl -s http://localhost:3000/api/login -H "Content-Type: application/json" -d '{"username":"test","password":"bad"}'
```

Now you have data flowing through all three pillars (metrics, logs, traces).

---

### Step 3: Prometheus — Your First Queries

Open http://localhost:9090

**The UI:**
- Top bar: query input field
- "Execute" button: runs the query
- Two tabs below: "Table" (raw values) and "Graph" (time-series chart)

**Try these queries (copy-paste into the query box):**

```promql
# 1. Is the app up? (1 = yes, 0 = no)
up{job="church-cms"}

# 2. Total HTTP requests made so far
churchcms_http_requests_total

# 3. Request rate per second (last 5 minutes)
rate(churchcms_http_requests_total[5m])

# 4. 95th percentile response time
histogram_quantile(0.95, rate(churchcms_http_request_duration_seconds_bucket[5m]))

# 5. Database pool connections (active vs idle)
churchcms_db_pool_active_connections
churchcms_db_pool_idle_connections

# 6. Login attempts by status
churchcms_login_attempts_total

# 7. Memory usage in MB
churchcms_process_resident_memory_bytes / 1024 / 1024

# 8. Node.js event loop lag (should be < 0.05s)
churchcms_nodejs_eventloop_lag_seconds
```

**How to read the Graph tab:**
- X-axis: time
- Y-axis: metric value
- Each line is a unique combination of labels
- Hover to see exact values at any point in time

**Check your targets:** Go to Status → Targets in the top menu. You should see:
- `church-cms` (UP) — your app on port 3000
- `church-cms-otel` (UP) — OpenTelemetry exporter on port 9464
- `prometheus` (UP) — Prometheus monitoring itself

If any show "DOWN", the scrape is failing (check the Error column for why).

---

### Step 4: Grafana — Navigating the Dashboards

Open http://localhost:3001 and login: **admin / admin** (skip password change).

**Finding the dashboards:**
1. Left sidebar → click the **Dashboards** icon (four squares)
2. You'll see a folder called "Church CMS"
3. Click it → three dashboards appear

**Dashboard: Application Overview**

This is your "at a glance" view. What to look for:
- **Request Rate panel:** Should show a line going up as you make requests. If flat = no traffic.
- **Response Time panel:** Three lines (p50, p95, p99). They should all be < 1 second. If p99 diverges significantly from p50, some requests are slow.
- **Error Rate panel:** Should be near 0%. If it spikes, something is broken.
- **Uptime panel:** Should say "UP" (green). If it says "DOWN" (red), Prometheus can't reach the app.

**Dashboard: Infrastructure**

This shows the NODE.JS RUNTIME health:
- **Memory panel:** Watch if the line goes UP over time without coming back down. That's a memory leak.
- **DB Connection Pool panel:** "Active" should be low (1-3). "Waiting" should be 0. If waiting > 0, you're running out of connections.
- **Event Loop Lag panel:** Should be near 0. If it spikes > 100ms, something is blocking the event loop (CPU-heavy work on the main thread).

**Dashboard: Business KPIs**

This is for non-engineers (product managers, team leads):
- **Login Activity:** Shows successful vs failed logins over time. A spike in failures could mean a brute force attack.
- **Members Created:** Shows church growth over time.

**Grafana Tips:**
- **Time range:** Top-right corner has a time picker. Set it to "Last 15 minutes" for recent data.
- **Auto-refresh:** Click the refresh icon → set to 10s for live updates.
- **Hover:** Hover over any graph point to see exact values and timestamp.
- **Zoom:** Click and drag on a graph to zoom into a time range.

---

### Step 5: Jaeger — Viewing Distributed Traces

Open http://localhost:16686

**The UI:**
- Left panel: Service dropdown, operation dropdown, time range, search button
- Main area: List of traces with their durations

**Finding your first trace:**
1. Service dropdown → select `church-cms`
2. Click "Find Traces"
3. You'll see a list of recent traces (each is one HTTP request)
4. Click on any one — preferably a `POST /api/login` or `GET /api/members`

**Reading a trace:**
```
Example: GET /api/members (total: 25ms)
├── express.middleware (0.3ms)
├── express.middleware (0.1ms)
├── GET /api/members (24ms)
│   └── pg.query: SELECT m.*, b.name... (18ms)  ← This is where time was spent
```

**What each span tells you:**
- **Duration bar:** The colored bar shows how long that operation took relative to the total request
- **Tags:** Click a span to see metadata (HTTP status, SQL query text, DB name)
- **Errors:** Red spans indicate failures (check the tags for error messages)

**Real debugging scenario:**
If a request took 3 seconds and the trace shows:
- Express middleware: 1ms
- Route handler: 5ms
- pg.query: 2994ms ← THE PROBLEM

You now know the database query is the bottleneck. Check the SQL in the span tags → maybe it needs an index.

**Jaeger Tips:**
- **Compare traces:** Find a fast trace and a slow trace for the same endpoint. Compare their spans to see what's different.
- **Filter by duration:** Use "Min Duration" to find only slow traces (e.g., > 1s)
- **Deep linking:** The trace URL is shareable. Paste it in a Slack thread when discussing an issue.

---

### Step 6: Loki — Querying Logs

Loki doesn't have its own UI. You access it through Grafana.

1. In Grafana, left sidebar → click **Explore** (compass icon)
2. Top-left dropdown → switch from "Prometheus" to **"Loki"**
3. In the query box, start typing

**Your first log query:**
```logql
{service="church-cms"}
```

Click "Run query" — you'll see all your app's logs streaming in.

**Filtering logs (most useful queries):**

```logql
# Only errors
{service="church-cms"} | json | level="error"

# Only login-related logs
{service="church-cms"} | json | message=~".*login.*"

# Logs for a specific user
{service="church-cms"} | json | username="admin"

# Logs with a specific trace ID (find all logs for one request)
{service="church-cms"} | json | trace_id="<paste-trace-id-here>"

# Count errors per minute (shows a graph instead of log lines)
rate({service="church-cms"} | json | level="error" [1m])

# Logs with response time info
{service="church-cms"} | json | line_format "{{.message}} [{{.level}}]"
```

**Loki UI Tips:**
- **Live tail:** Click the "Live" button (top-right) to stream logs in real time as they happen.
- **Time range matters:** If you see "no data", expand the time range (top-right picker).
- **Log line expansion:** Click any log line to expand it and see all JSON fields parsed.
- **Log-to-Trace:** If you see a `trace_id` field in a log entry, copy it and search for it in Jaeger to see the full request trace.

---

### Step 7: Alertmanager — Understanding Alert State

Open http://localhost:9093

**The UI:**
- **Alerts tab:** Shows currently firing alerts (should be empty if everything is healthy)
- **Silences tab:** Shows active silences (scheduled maintenance suppression)
- **Status tab:** Shows Alertmanager configuration and health

**To see alert RULES (not Alertmanager):** Go to Prometheus → http://localhost:9090/alerts

Here you'll see ALL your alert rules with their states:
- **Inactive (green):** Condition is NOT met. Everything is fine.
- **Pending (yellow):** Condition is met but hasn't been true long enough (waiting for `for` duration).
- **Firing (red):** Condition has been true for the required duration. Alert is active.

**Trigger an alert manually (to see how it works):**

```bash
# Stop the app container — this will trigger ServiceDown alert
docker compose stop app

# Wait 60 seconds (the alert has `for: 1m`)
# Then check: http://localhost:9090/alerts
# ServiceDown should change from Inactive → Pending → Firing

# Check Alertmanager: http://localhost:9093/#/alerts
# You should see the fired alert with its annotations

# Restart the app
docker compose start app

# Wait 60 seconds — alert should resolve
```

**Alertmanager concepts to observe:**
- When an alert fires, Alertmanager **groups** it (see the grouping)
- If you fire multiple alerts, they get **batched** (one notification, not spam)
- The **repeat_interval** prevents re-sending the same alert every 15 seconds

---

### Step 8: Load Testing + Watching Dashboards (The Real Demo)

This is where it all comes together. You stress the app and WATCH the monitoring stack react in real time.

**Setup:** Open these side by side (multiple browser tabs):
1. Grafana → Application Overview dashboard (set auto-refresh to 10s)
2. Grafana → Infrastructure dashboard
3. Terminal for k6

**Important:** Before running load tests, increase the rate limit to avoid false failures:

Add this to your `.env` file:
```
RATE_LIMIT_LOGIN_MAX=10000
```

Then restart the app:
```bash
docker compose restart app
sleep 10
```

**Run the smoke test (basic sanity):**
```bash
make load-smoke
```

Watch Grafana: you should see a small uptick in request rate and a few data points in latency.

**Run the stress test (find limits):**
```bash
make load-stress
```

**What to watch in real time:**
- Application Overview: Request rate should climb as VUs increase (50 → 100 → 150)
- Response Time: p95/p99 should stay stable initially, then diverge from p50 at higher load
- Infrastructure: CPU climbs, DB pool active connections increase
- If latency spikes: check DB pool "Waiting" — if > 0, you've hit the pool limit

**Run the spike test (sudden burst):**
```bash
make load-spike
```

**What to watch:**
- Request rate jumps suddenly (10 → 200 VUs in 10 seconds)
- Error rate may spike briefly (rate limiting kicks in — expected)
- After spike passes (drops back to 10 VUs), does latency return to baseline? If yes = healthy recovery. If no = resource leak.

**After the tests, check:**
- Jaeger: You'll have hundreds of traces. Sort by duration to find the slowest ones.
- Loki: `{service="church-cms"} | json | level="error"` — any errors during the test?
- Prometheus alerts: http://localhost:9090/alerts — did any alerts fire?

---

### Step 9: The Complete Debugging Workflow (Putting It All Together)

Pretend you just got paged: "Users report the app is slow."

**Minute 0: Triage (Grafana Application Overview)**
- Open the dashboard. Check error rate and p95 latency.
- See: p95 spiked from 100ms to 3s at 2:15pm. Error rate is 8%.
- Conclusion: something broke at 2:15pm.

**Minute 1: Identify the endpoint (Grafana Application Overview → "Requests by Route")**
- See: `/api/members` has most of the latency. Other routes are fine.
- Conclusion: the problem is specific to the members endpoint.

**Minute 2: Check infrastructure (Grafana Infrastructure dashboard)**
- DB pool: "Waiting" = 5 clients. Pool is exhausted.
- Memory: flat (no leak). CPU: 40% (not compute-bound).
- Conclusion: all DB connections are busy. New queries are queuing.

**Minute 3: Find the logs (Grafana Explore → Loki)**
```logql
{service="church-cms"} | json | level="error"
```
- See: "Connection timeout waiting for available connection" at 2:15pm.
- Grab the `trace_id` from the error log.

**Minute 4: Trace the request (Jaeger)**
- Search for the trace_id in Jaeger.
- See: `pg.query: SELECT m.*, b.name FROM members m JOIN branches b...` took 12 seconds.
- The SQL is doing a full table scan because `branch_id` has no index.

**Minute 5: Root cause identified.**
- A new query was deployed without an index.
- Under load, the slow query holds connections → pool exhausts → everything queues.
- Fix: `CREATE INDEX idx_members_branch_id ON members(branch_id);`

**Total time from page to root cause: 5 minutes.**
Without observability, this would be hours of guessing, adding console.logs, redeploying, and hoping.

---

### Quick Reference: What Tool Answers What Question

| Question | Tool | Where to Look |
|----------|------|---------------|
| Is the app alive? | Prometheus | `up{job="church-cms"}` or Grafana Uptime panel |
| How fast are responses? | Grafana | Application Overview → Response Time panel |
| What percentage of requests fail? | Grafana | Application Overview → Error Rate panel |
| Why is this ONE request slow? | Jaeger | Find trace → look at span durations |
| What errors happened at 2pm? | Loki (via Grafana) | `{service="..."} \| json \| level="error"` |
| Is the DB overloaded? | Grafana | Infrastructure → DB Connection Pool |
| Is there a memory leak? | Grafana | Infrastructure → Memory (RSS) trending up? |
| Are users logging in? | Grafana | Business KPIs → Login Activity |
| Should I be worried right now? | Prometheus Alerts | http://localhost:9090/alerts |
| Who got notified? | Alertmanager | http://localhost:9093/#/alerts |
| What's the full story of a request? | Jaeger | Service → Find Traces → Click one |
| How does this request's log connect to its trace? | Loki + Jaeger | Find `trace_id` in log → search in Jaeger |

---

### Troubleshooting the Monitoring Stack

**"No data" in Grafana dashboards:**
1. Check time range (top-right) — set to "Last 15 minutes"
2. Check Prometheus targets: http://localhost:9090/targets — are they UP?
3. Generate some traffic (curl the app) — dashboards need data to show

**"Cannot connect to datasource" in Grafana:**
- The datasources are pre-provisioned. If they fail, restart Grafana: `docker compose restart grafana`

**Prometheus shows target as DOWN:**
- The app container might still be starting. Wait 30 seconds.
- Check if the app is healthy: `curl http://localhost:3000/health`

**Jaeger shows no traces:**
- Ensure `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318` is in docker-compose.yml
- OTel excludes `/health` and `/ready` from tracing (by design). Hit `/api/branches` instead.

**Loki shows no logs:**
- Promtail needs access to the Docker socket. Check: `docker compose logs promtail`
- Ensure the app is actually generating logs (make some requests)

**k6 load test fails with rate limiting:**
- Add `RATE_LIMIT_LOGIN_MAX=10000` to `.env` and restart the app
- Or restart the app to reset in-memory rate limit counters: `docker compose restart app`

---

## What's Next

With observability in place, you can now:
1. **Set up real SLOs** and track error budgets in Grafana
2. **Route alerts** to Slack/PagerDuty (update alertmanager.yml with webhook URLs)
3. **Run k6 load tests** regularly and watch dashboards under stress
4. **Move to Kubernetes** where Prometheus/Grafana/Loki deploy as Helm charts
5. **Add Tempo** (Grafana's tracing backend) to replace Jaeger for tighter Grafana integration
6. **Add chaos engineering** — kill pods/containers and watch observability catch it

This is the foundation of professional SRE work. Everything from here is refinement.
