# Runbook: High Error Rate

**Alert:** `HighErrorRate` (>5%) or `CriticalErrorRate` (>25%)  
**Severity:** P2 (High) or P1 if >25%  
**Meaning:** A significant percentage of requests are returning 5xx server errors.

---

## Symptoms

- Alert fires: "X% of requests are returning 5xx errors"
- Users report intermittent failures ("sometimes it works, sometimes it doesn't")
- CloudWatch shows HTTPCode_Target_5XX_Count increasing

---

## Step-by-Step Resolution

### Step 1: Quantify the problem (30 seconds)

```bash
# Current error rate
ALB_SUFFIX=$(aws elbv2 describe-load-balancers --names church-cms-prod-alb \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text | sed 's|.*loadbalancer/||')

# 5xx count in last 5 minutes
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=$ALB_SUFFIX \
  --start-time $(date -u -v-5M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Sum --output table

# Total requests (for context)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" --metric-name RequestCount \
  --dimensions Name=LoadBalancer,Value=$ALB_SUFFIX \
  --start-time $(date -u -v-5M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Sum --output table
```

### Step 2: Check if it correlates with a recent deployment

```bash
aws ecs describe-services --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].events[:5].{time:createdAt,message:message}' --output table
```

If a deployment happened in the last 10 minutes → likely the new code caused it.

**Immediate action:** Rollback
```bash
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --force-new-deployment
```

### Step 3: Check application logs for the error

```bash
# Find the actual errors
aws logs tail /ecs/church-cms-prod --since 10m --filter-pattern "ERROR"

# Look for stack traces
aws logs tail /ecs/church-cms-prod --since 10m --filter-pattern "Error\|error\|FATAL\|TypeError\|ReferenceError"
```

**Common patterns:**

| Error Pattern | Likely Cause | Fix |
|--------------|-------------|-----|
| `ECONNREFUSED 5432` | Can't connect to database | Check RDS status, security groups |
| `relation "users" does not exist` | Migrations not run | Run migration task |
| `invalid input syntax for type` | Bad data/query | Code bug — fix and redeploy |
| `out of memory` | Memory leak under load | Increase task memory, investigate leak |
| `ETIMEDOUT` | Network/dependency timeout | Check NAT Gateway, security groups |

### Step 4: Check database health

```bash
# Is RDS accessible?
curl -s https://app.johndesiventures.website/ready
# If "database":"disconnected" → DB problem

# RDS CPU (is it overloaded?)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/RDS" --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --start-time $(date -u -v-10M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Average --output table

# Connection count
aws cloudwatch get-metric-statistics \
  --namespace "AWS/RDS" --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --start-time $(date -u -v-10M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Average --output table
```

### Step 5: Mitigate

| Root Cause | Action |
|-----------|--------|
| Bad deployment | Rollback (Step 2) |
| Database overloaded | Scale down ECS tasks to reduce connections, investigate slow queries |
| Memory exhaustion | Restart tasks: `--force-new-deployment` |
| External dependency down | Nothing to do — wait for it to recover, alert users |

### Step 6: Verify recovery

```bash
# Error rate should drop after mitigation
sleep 120
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=$ALB_SUFFIX \
  --start-time $(date -u -v-5M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Sum --output table
# Should show 0 or near-0
```

---

## Post-Resolution

- [ ] Identify the specific code path causing 5xx
- [ ] Add a test that would have caught this before deploy
- [ ] Review if staging tests missed this scenario

---
