# Runbook: High Latency

**Alert:** `HighLatencyP95` (>2s) or `CriticalLatencyP99` (>5s)  
**Severity:** P2 (High)  
**Meaning:** Users are experiencing slow page loads and API responses.

---

## Step 1: Confirm and measure

```bash
# Measure current response time
curl -w "\nTotal time: %{time_total}s\n" -s -o /dev/null https://app.johndesiventures.website/health
curl -w "\nTotal time: %{time_total}s\n" -s -o /dev/null https://app.johndesiventures.website/api/stats

# Check ALB latency metric
ALB_SUFFIX=$(aws elbv2 describe-load-balancers --names church-cms-prod-alb \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text | sed 's|.*loadbalancer/||')

aws cloudwatch get-metric-statistics \
  --namespace "AWS/ApplicationELB" --metric-name TargetResponseTime \
  --dimensions Name=LoadBalancer,Value=$ALB_SUFFIX \
  --start-time $(date -u -v-10M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics p95 --output table
```

### Step 2: Identify the bottleneck

```bash
# Is it CPU? (compute-bound)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ECS" --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=church-cms-prod-cluster Name=ServiceName,Value=church-cms-prod-service \
  --start-time $(date -u -v-10M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Average --output table

# Is it the database? (query-bound)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/RDS" --metric-name ReadLatency \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --start-time $(date -u -v-10M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Average --output table

# Is it connections? (pool saturation)
aws cloudwatch get-metric-statistics \
  --namespace "AWS/RDS" --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --start-time $(date -u -v-10M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Maximum --output table
```

**Diagnosis:**

| Metric | High Value Means |
|--------|-----------------|
| ECS CPU > 70% | App is compute-bound → scale up tasks |
| RDS ReadLatency > 20ms | Slow queries → need indexes or query optimization |
| RDS Connections near max | Pool exhausted → see DatabasePoolExhausted runbook |
| ECS CPU low + RDS low | Network issue or external dependency slow |

### Step 3: Mitigate

```bash
# If CPU-bound: scale up
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --desired-count 4

# If DB-bound: restart tasks (temporary relief — resets connection pool)
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --force-new-deployment

# If traffic spike: verify autoscaling is working
aws ecs describe-services --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].{desired:desiredCount,running:runningCount}'
```

### Step 4: Verify improvement

```bash
sleep 120
curl -w "\nTotal time: %{time_total}s\n" -s -o /dev/null https://app.johndesiventures.website/health
# Should be < 500ms
```

---

## Common Root Causes

| Cause | Clues | Long-term Fix |
|-------|-------|--------------|
| Missing database index | Latency correlates with specific endpoint | Add index, deploy |
| N+1 query pattern | Many DB connections, high read latency | Optimize query (JOIN instead of loop) |
| Traffic spike | Request count spiked, CPU followed | Verify autoscaling, increase max_count |
| Memory pressure / GC | Memory near limit, event loop lag | Increase task memory |
| Cold start after scale-up | Latency spikes briefly then resolves | Expected behavior, no action needed |

---
