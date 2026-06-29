# CloudWatch Production Monitoring — Hands-On Guide

This guide shows you how to monitor your production app using AWS CloudWatch — the monitoring tool that's already built into your ECS deployment at zero extra cost.

---

## Table of Contents

1. [What CloudWatch Gives You (Free)](#what-cloudwatch-gives-you-free)
2. [Hands-On: Viewing Application Logs](#hands-on-viewing-application-logs)
3. [Hands-On: Querying Logs (CloudWatch Insights)](#hands-on-querying-logs-cloudwatch-insights)
4. [Hands-On: Viewing Metrics (CPU, Memory, Requests)](#hands-on-viewing-metrics)
5. [Hands-On: Creating Alarms](#hands-on-creating-alarms)
6. [Hands-On: Creating a Dashboard](#hands-on-creating-a-dashboard)
7. [Real-World Scenarios](#real-world-scenarios)
8. [CloudWatch vs Local Stack (Comparison)](#cloudwatch-vs-local-stack-comparison)
9. [Cost](#cost)

---

## What CloudWatch Gives You (Free)

Your ECS deployment AUTOMATICALLY sends data to CloudWatch. No extra setup needed:

| Data | Source | What You Get |
|------|--------|-------------|
| **Application Logs** | Container stdout/stderr → CloudWatch Logs | Every log line your app writes |
| **ECS Metrics** | ECS agent reports every 1 min | CPU %, Memory %, Task count |
| **ALB Metrics** | Load balancer reports | Request count, response codes, latency |
| **RDS Metrics** | Database reports | Connections, IOPS, CPU, free storage |

All of this is happening RIGHT NOW in your production environment. Let's explore it.

---

## Hands-On: Viewing Application Logs

### From the CLI (quickest)

```bash
# Last 10 minutes of logs
aws logs tail /ecs/church-cms-prod --since 10m

# Follow logs in real-time (like docker compose logs -f)
aws logs tail /ecs/church-cms-prod --follow

# Filter for errors only
aws logs tail /ecs/church-cms-prod --since 1h --filter-pattern "error"

# Filter for failed logins
aws logs tail /ecs/church-cms-prod --since 1h --filter-pattern "Failed login"

# Filter for a specific request ID
aws logs tail /ecs/church-cms-prod --since 1h --filter-pattern "24a53cae"
```

### From the AWS Console (visual)

1. Go to: https://console.aws.amazon.com/cloudwatch/home?region=us-east-1
2. Left sidebar → Logs → Log groups
3. Click `/ecs/church-cms-prod`
4. Click the latest log stream (named like `ecs/church-cms-app/abc123...`)
5. You'll see all your application logs — searchable, filterable

### What You'll See in the Logs

```
# Successful login (structured JSON):
info: User logged in {"environment":"prod","requestId":"24a53cae-...","role":"main_leader","username":"admin"}

# Failed login attempt (WARNING level):
warn: Failed login attempt {"environment":"prod","requestId":"91830acc-...","username":"hacker"}

# HTTP access log:
info: 102.89.85.224 - - [29/Jun/2026:12:05:51 +0000] "POST /api/login HTTP/1.1" 200 317 "-" "curl/8.7.1"

# Bot/scanner traffic (you'll see unknown IPs hitting your app):
info: 35.226.164.16 - - "GET / HTTP/1.1" 200 15057 "-" "Mozilla/5.0 (Windows NT 6.2...)"
```

**Real discovery:** Your production app is already being hit by bots/scanners within minutes of going live. This is normal — every public HTTP endpoint gets probed.

---

## Hands-On: Querying Logs (CloudWatch Insights)

CloudWatch Logs Insights is like SQL for your logs. Much more powerful than `--filter-pattern`.

### From the CLI

```bash
# Count requests per status code (last hour)
aws logs start-query \
  --log-group-name /ecs/church-cms-prod \
  --start-time $(date -u -v-1H +%s) \
  --end-time $(date -u +%s) \
  --query-string 'fields @timestamp, @message | filter @message like /HTTP/ | stats count() by status_code'

# Find all error logs
aws logs start-query \
  --log-group-name /ecs/church-cms-prod \
  --start-time $(date -u -v-1H +%s) \
  --end-time $(date -u +%s) \
  --query-string 'fields @timestamp, @message | filter @message like /error|Error|ERROR/'

# Get the query results (use the queryId returned above)
aws logs get-query-results --query-id "YOUR_QUERY_ID"
```

### From the AWS Console (easier)

1. CloudWatch → Logs → Logs Insights
2. Select log group: `/ecs/church-cms-prod`
3. Try these queries:

```sql
-- All failed login attempts (who's trying to break in?)
fields @timestamp, @message
| filter @message like /Failed login/
| sort @timestamp desc
| limit 50

-- Count of requests per minute (traffic pattern)
fields @timestamp
| filter @message like /HTTP/
| stats count() as requests by bin(1m)

-- All warning and error logs
fields @timestamp, @message
| filter @message like /warn|error/
| sort @timestamp desc

-- Top IP addresses hitting your app
fields @timestamp, @message
| filter @message like /HTTP/
| parse @message /(?<ip>\d+\.\d+\.\d+\.\d+)/
| stats count() as hits by ip
| sort hits desc
| limit 10

-- Response time patterns (from access logs)
fields @timestamp, @message
| filter @message like /POST.*\/api\/login/
| sort @timestamp desc
| limit 20
```

---

## Hands-On: Viewing Metrics

### ECS Metrics (CPU and Memory)

```bash
# CPU utilization (last hour, 5-minute intervals)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ECS" \
  --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=church-cms-prod-cluster Name=ServiceName,Value=church-cms-prod-service \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --output table

# Memory utilization
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ECS" \
  --metric-name MemoryUtilization \
  --dimensions Name=ClusterName,Value=church-cms-prod-cluster Name=ServiceName,Value=church-cms-prod-service \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --output table
```

### ALB Metrics (Request Count, Errors, Latency)

```bash
# Get ALB identifier
ALB_ARN_SUFFIX=$(aws elbv2 describe-load-balancers --names church-cms-prod-alb \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text | sed 's|.*loadbalancer/||')

# Total requests (last hour)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name RequestCount \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum \
  --output table

# 5xx errors (server errors)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum \
  --output table

# Average response time
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name TargetResponseTime \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --output table

# Healthy host count (should match your desired task count)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name HealthyHostCount \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX Name=TargetGroup,Value=$(aws elbv2 describe-target-groups --names church-cms-prod-tg --query 'TargetGroups[0].TargetGroupArn' --output text | sed 's|.*:||') \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --output table
```

### RDS Metrics (Database Health)

```bash
# Database CPU
aws cloudwatch get-metric-statistics \
  --namespace "AWS/RDS" \
  --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --output table

# Database connections
aws cloudwatch get-metric-statistics \
  --namespace "AWS/RDS" \
  --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --output table

# Free storage space (in bytes)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/RDS" \
  --metric-name FreeStorageSpace \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --output table
```

---

## Hands-On: Creating Alarms

Alarms notify you when something goes wrong — without you watching a dashboard.

### Create a High CPU Alarm

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "church-cms-prod-high-cpu" \
  --alarm-description "ECS CPU above 70% for 5 minutes" \
  --metric-name CPUUtilization \
  --namespace "AWS/ECS" \
  --statistic Average \
  --period 60 \
  --threshold 70 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 5 \
  --dimensions Name=ClusterName,Value=church-cms-prod-cluster Name=ServiceName,Value=church-cms-prod-service \
  --treat-missing-data notBreaching
```

### Create a 5xx Error Alarm

```bash
ALB_ARN_SUFFIX=$(aws elbv2 describe-load-balancers --names church-cms-prod-alb \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text | sed 's|.*loadbalancer/||')

aws cloudwatch put-metric-alarm \
  --alarm-name "church-cms-prod-5xx-errors" \
  --alarm-description "More than 10 server errors in 5 minutes" \
  --metric-name HTTPCode_Target_5XX_Count \
  --namespace "AWS/ApplicationELB" \
  --statistic Sum \
  --period 300 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX \
  --treat-missing-data notBreaching
```

### Create a Database Connection Alarm

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "church-cms-prod-db-connections" \
  --alarm-description "Database connections above 80% capacity" \
  --metric-name DatabaseConnections \
  --namespace "AWS/RDS" \
  --statistic Average \
  --period 300 \
  --threshold 40 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --treat-missing-data notBreaching
```

### Check Alarm Status

```bash
aws cloudwatch describe-alarms \
  --alarm-name-prefix "church-cms-prod" \
  --query 'MetricAlarms[*].{Name:AlarmName,State:StateValue,Reason:StateReason}' \
  --output table
```

All alarms should show `OK` state (conditions not met = everything is healthy).

---

## Hands-On: Creating a Dashboard

Create a CloudWatch dashboard that shows everything at a glance:

```bash
aws cloudwatch put-dashboard --dashboard-name "ChurchCMS-Production" --dashboard-body '{
  "widgets": [
    {
      "type": "metric",
      "x": 0, "y": 0, "width": 12, "height": 6,
      "properties": {
        "title": "ECS CPU & Memory",
        "metrics": [
          ["AWS/ECS", "CPUUtilization", "ClusterName", "church-cms-prod-cluster", "ServiceName", "church-cms-prod-service", {"label": "CPU %"}],
          ["AWS/ECS", "MemoryUtilization", "ClusterName", "church-cms-prod-cluster", "ServiceName", "church-cms-prod-service", {"label": "Memory %"}]
        ],
        "period": 300,
        "stat": "Average",
        "region": "us-east-1"
      }
    },
    {
      "type": "metric",
      "x": 12, "y": 0, "width": 12, "height": 6,
      "properties": {
        "title": "ALB Request Count",
        "metrics": [
          ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", "REPLACE_WITH_ALB_ARN_SUFFIX", {"label": "Requests", "stat": "Sum"}]
        ],
        "period": 60,
        "region": "us-east-1"
      }
    },
    {
      "type": "metric",
      "x": 0, "y": 6, "width": 12, "height": 6,
      "properties": {
        "title": "Response Codes",
        "metrics": [
          ["AWS/ApplicationELB", "HTTPCode_Target_2XX_Count", "LoadBalancer", "REPLACE_WITH_ALB_ARN_SUFFIX", {"label": "2xx", "stat": "Sum", "color": "#2ca02c"}],
          ["AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", "LoadBalancer", "REPLACE_WITH_ALB_ARN_SUFFIX", {"label": "4xx", "stat": "Sum", "color": "#ff7f0e"}],
          ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", "REPLACE_WITH_ALB_ARN_SUFFIX", {"label": "5xx", "stat": "Sum", "color": "#d62728"}]
        ],
        "period": 60,
        "region": "us-east-1"
      }
    },
    {
      "type": "metric",
      "x": 12, "y": 6, "width": 12, "height": 6,
      "properties": {
        "title": "Database Health",
        "metrics": [
          ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", "church-cms-prod-db", {"label": "DB CPU %"}],
          ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", "church-cms-prod-db", {"label": "Connections", "yAxis": "right"}]
        ],
        "period": 300,
        "stat": "Average",
        "region": "us-east-1"
      }
    },
    {
      "type": "log",
      "x": 0, "y": 12, "width": 24, "height": 6,
      "properties": {
        "title": "Recent Error Logs",
        "query": "SOURCE '/ecs/church-cms-prod' | fields @timestamp, @message | filter @message like /error|Error|warn|WARN/ | sort @timestamp desc | limit 20",
        "region": "us-east-1"
      }
    }
  ]
}'
```

**View it:** https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=ChurchCMS-Production

Or: AWS Console → CloudWatch → Dashboards → ChurchCMS-Production

---

## Real-World Scenarios

### Scenario 1: "Is anyone using the app?"

```bash
# Request count over last 24 hours (5-minute bins)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name RequestCount \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX \
  --start-time $(date -u -v-24H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 \
  --statistics Sum \
  --output table
```

### Scenario 2: "Someone reported the app is slow"

```bash
# Check response time (last 30 minutes)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name TargetResponseTime \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX \
  --start-time $(date -u -v-30M +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics p95 \
  --output table

# Check if DB is the bottleneck
aws cloudwatch get-metric-statistics \
  --namespace "AWS/RDS" \
  --metric-name ReadLatency \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --start-time $(date -u -v-30M +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Average \
  --output table
```

### Scenario 3: "Are we under attack?"

```bash
# Check failed login attempts in logs
aws logs filter-log-events \
  --log-group-name /ecs/church-cms-prod \
  --filter-pattern "Failed login" \
  --start-time $(date -u -v-1H +%s)000 \
  --query 'events[*].message' --output text

# Check 4xx error spike (unauthorized/forbidden)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name HTTPCode_Target_4XX_Count \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Sum \
  --output table
```

### Scenario 4: "Did the last deployment break anything?"

```bash
# Check for 5xx errors in last 15 minutes
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX \
  --start-time $(date -u -v-15M +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Sum \
  --output table

# Check healthy host count (should be 2)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" \
  --metric-name HealthyHostCount \
  --dimensions Name=LoadBalancer,Value=$ALB_ARN_SUFFIX Name=TargetGroup,Value=$(aws elbv2 describe-target-groups --names church-cms-prod-tg --query 'TargetGroups[0].TargetGroupArn' --output text | sed 's|.*:||') \
  --start-time $(date -u -v-15M +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Minimum \
  --output table

# Check app logs for errors
aws logs tail /ecs/church-cms-prod --since 15m --filter-pattern "ERROR"
```

---

## CloudWatch vs Local Stack (Comparison)

| Feature | CloudWatch (Production) | Local Stack (Docker) |
|---------|------------------------|---------------------|
| **Logs** | CloudWatch Logs (CLI + Console) | Loki + Grafana Explore |
| **Metrics** | CloudWatch Metrics (AWS infra) | Prometheus + custom app metrics |
| **Dashboards** | CloudWatch Dashboards | Grafana (richer, more flexible) |
| **Alerts** | CloudWatch Alarms → SNS → Email/Slack | Prometheus Alertmanager → Slack |
| **Traces** | AWS X-Ray (not configured) | Jaeger (OpenTelemetry) |
| **Cost** | Free tier covers most basic usage | $0 (runs on your laptop) |
| **Custom metrics** | Need CloudWatch agent or SDK | prom-client (already in your app) |
| **Query language** | CloudWatch Insights (SQL-like) | LogQL (Loki), PromQL (Prometheus) |

**Key difference:** CloudWatch gives you INFRASTRUCTURE metrics for free (CPU, memory, requests). Your local stack gives you APPLICATION metrics (login attempts, members created, DB pool). Both are needed for complete observability.

---

## Cost

CloudWatch has a generous free tier:

| Feature | Free Tier | After Free Tier |
|---------|-----------|----------------|
| Logs ingestion | 5 GB/month | $0.50/GB |
| Logs storage | 5 GB/month | $0.03/GB/month |
| Metrics | 10 custom metrics | $0.30/metric/month |
| Alarms | 10 alarms | $0.10/alarm/month |
| Dashboards | 3 dashboards | $3/dashboard/month |
| API calls | 1M free | negligible |

For your setup (~3 environments, light traffic): **$0-5/month** for CloudWatch.

---
