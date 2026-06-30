# Runbook: ServiceDown

**Alert:** `ServiceDown`  
**Severity:** P1 (Critical)  
**Meaning:** The application is completely unreachable. Prometheus cannot scrape the /metrics endpoint.

---

## Symptoms

- CloudWatch alarm or Prometheus alert fires
- `curl https://app.johndesiventures.website/health` returns error or timeout
- Users report "page won't load"

---

## Step-by-Step Resolution

### Step 1: Confirm the outage (30 seconds)

```bash
# Hit the app directly
curl -s --max-time 5 https://app.johndesiventures.website/health
# Expected if DOWN: timeout, connection refused, or no response

# Hit the ALB directly (bypass DNS)
curl -sk --max-time 5 https://church-cms-prod-alb-XXXXX.us-east-1.elb.amazonaws.com/health
# If ALB responds but domain doesn't → DNS issue, not app issue
```

### Step 2: Check ECS service (1 minute)

```bash
aws ecs describe-services --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,events:events[:3].message}' \
  --output json
```

**Interpret:**
- `running: 0, desired: 2` → Tasks are crashing. Go to Step 3.
- `running: 2, desired: 2` → Tasks are running but ALB can't reach them. Go to Step 4.
- `running: 1, desired: 2` → One task crashed, one surviving. ECS is self-healing. Monitor.

### Step 3: Tasks are crashing — check WHY

```bash
# Get the most recent stopped task
TASK=$(aws ecs list-tasks --cluster church-cms-prod-cluster \
  --desired-status STOPPED --query 'taskArns[0]' --output text)

# Why did it stop?
aws ecs describe-tasks --cluster church-cms-prod-cluster --tasks $TASK \
  --query 'tasks[0].{reason:stoppedReason,status:lastStatus,container:containers[0].{exit:exitCode,reason:reason}}'
```

**Common reasons:**

| Stopped Reason | Fix |
|---------------|-----|
| `OutOfMemoryError` | Increase memory in task definition (Terraform → apply) |
| `CannotPullContainerError` | Image doesn't exist in GHCR. Check image tag. |
| `ResourceInitializationError` | Can't read secrets. Check Secrets Manager + IAM. |
| `Essential container exited` | App crashed on startup. Check logs. |

```bash
# Check the logs for crash details
aws logs tail /ecs/church-cms-prod --since 10m
```

### Step 4: Tasks running but ALB can't reach them

```bash
# Check target health
TG_ARN=$(aws elbv2 describe-target-groups --names church-cms-prod-tg \
  --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn $TG_ARN
```

**If targets are "unhealthy":**
- The /health endpoint is failing INSIDE the container
- Check if the container process actually started:
  ```bash
  aws logs tail /ecs/church-cms-prod --since 5m | grep -i "started\|error\|fatal"
  ```

**If targets are "draining" or "unused":**
- New deployment in progress. Wait 2-3 minutes.

### Step 5: Immediate mitigation

```bash
# Option A: Force redeploy (pulls current image fresh)
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --force-new-deployment

# Option B: Rollback to previous task definition
PREV_TASK_DEF=$(aws ecs describe-services --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].taskDefinition' --output text | sed 's/:.*/:/' | head -1)
# Then manually set the previous revision

# Option C: Scale up (if it's a capacity issue)
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --desired-count 4
```

### Step 6: Verify recovery

```bash
# Wait 60 seconds, then check
sleep 60
curl -s https://app.johndesiventures.website/health
# Should return: {"status":"ok",...}

aws ecs describe-services --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].{running:runningCount,status:status}'
# Should show: running = desired count
```

---

## Post-Resolution

- [ ] Write postmortem if downtime > 5 minutes
- [ ] Check if alert fired fast enough
- [ ] Add preventive measure (better health check? more replicas?)

---
