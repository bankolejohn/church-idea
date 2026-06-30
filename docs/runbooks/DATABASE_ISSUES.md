# Runbook: Database Issues

Covers: `DatabasePoolExhausted`, database failover, connection failures.

---

## Alert: DatabasePoolExhausted

**Meaning:** All database connections in the pool (20) are in use. New queries are queuing. Latency is spiking.

### Step 1: Confirm

```bash
# Check /ready endpoint (shows DB connectivity)
curl -s https://app.johndesiventures.website/ready
# If "database":"disconnected" → complete DB failure (go to Connection Failure section)
# If "database":"connected" but app is slow → pool exhaustion

# Check RDS connections
aws cloudwatch get-metric-statistics \
  --namespace "AWS/RDS" --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=church-cms-prod-db \
  --start-time $(date -u -v-10M +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Maximum --output table
```

### Step 2: Identify the cause

```bash
# Check logs for slow queries or connection errors
aws logs tail /ecs/church-cms-prod --since 10m --filter-pattern "timeout\|pool\|connection"
```

**Common causes:**
- Too many ECS tasks (each opens DB_POOL_MAX connections)
- Slow queries holding connections too long
- Connection leak (app doesn't release connections)
- Sudden traffic spike

### Step 3: Mitigate

```bash
# Option A: Reduce tasks (fewer connections)
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --desired-count 1

# Option B: Restart tasks (resets connection pool)
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --force-new-deployment

# Option C: If queries are slow, kill long-running queries (requires DB access)
# This requires ECS Exec or a bastion host
```

---

## Database Connection Failure

**Symptom:** `/ready` returns `{"database":"disconnected"}` or app logs show `ECONNREFUSED`.

### Step 1: Is RDS running?

```bash
aws rds describe-db-instances \
  --db-instance-identifier church-cms-prod-db \
  --query 'DBInstances[0].{Status:DBInstanceStatus,AZ:AvailabilityZone}' --output table
```

| Status | Meaning |
|--------|---------|
| `available` | Running fine — issue is network/security group |
| `backing-up` | Backup in progress — might be slow but accessible |
| `modifying` | Configuration change applying — wait |
| `rebooting` | Restarting — wait 2-5 minutes |
| `failed` | Critical failure — contact AWS support |

### Step 2: Check security groups

```bash
# Does the ECS security group allow outbound to port 5432?
aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=church-cms-prod-ecs-sg" \
  --query 'SecurityGroups[0].IpPermissionsEgress'

# Does the RDS security group allow inbound from ECS?
aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=church-cms-prod-rds-sg" \
  --query 'SecurityGroups[0].IpPermissions'
```

### Step 3: Check secrets

```bash
# Is the DATABASE_URL secret still valid?
aws secretsmanager get-secret-value \
  --secret-id "church-cms/prod/database-url" \
  --query 'SecretString' --output text
# Verify the hostname matches the current RDS endpoint
```

---

## Database Failover (Multi-AZ)

**Symptom:** Brief (30-60s) connection errors, then recovery. RDS Multi-AZ failover occurred.

### When This Happens

- AWS detects primary DB instance failure
- Scheduled maintenance (patching)
- You triggered it manually: `aws rds reboot-db-instance --force-failover`

### What to Do

**Usually: nothing.** Multi-AZ failover is automatic:
1. AWS promotes the standby replica (~30 seconds)
2. DNS endpoint stays the same (no config change needed)
3. App reconnects automatically (pg Pool handles this)
4. The old primary becomes the new standby

### Verify Recovery

```bash
# Check RDS status
aws rds describe-db-instances \
  --db-instance-identifier church-cms-prod-db \
  --query 'DBInstances[0].{Status:DBInstanceStatus,AZ:AvailabilityZone,MultiAZ:MultiAZ}'

# Check app connectivity
curl -s https://app.johndesiventures.website/ready
# Should return: {"database":"connected"}
```

### If App Doesn't Recover

If `/ready` still shows disconnected after 2 minutes:

```bash
# Force restart the ECS tasks (resets connection pools)
aws ecs update-service --cluster church-cms-prod-cluster \
  --service church-cms-prod-service --force-new-deployment
```

---
