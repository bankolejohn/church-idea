# Debugging Commands Reference

Every debugging command used in this project, explained. This is your playbook for diagnosing production issues.

---

## Table of Contents

1. [The Debugging Mindset](#the-debugging-mindset)
2. [curl — HTTP Debugging](#curl--http-debugging)
3. [AWS CLI — Infrastructure Debugging](#aws-cli--infrastructure-debugging)
4. [Docker — Container Debugging](#docker--container-debugging)
5. [Terraform — IaC Debugging](#terraform--iac-debugging)
6. [Git — Pipeline Debugging](#git--pipeline-debugging)
7. [DNS — Network Debugging](#dns--network-debugging)
8. [The Debugging Playbook (Decision Tree)](#the-debugging-playbook)

---

## The Debugging Mindset

Before any command, ask these questions in order:

```
1. Is the NETWORK reachable? (DNS, firewall, security groups)
2. Is the PROCESS running? (container, task, service)
3. Is the APP healthy? (health check, readiness)
4. Is the DEPENDENCY working? (database, secrets, external APIs)
5. Is the SPECIFIC FEATURE broken? (login, API endpoint)
```

Always isolate layers. Don't guess — PROVE which layer is broken.

---

## curl — HTTP Debugging

`curl` is the single most important debugging tool. It lets you make HTTP requests and see EXACTLY what's happening.

### Basic Requests

```bash
# Simple GET request
curl http://localhost:3000/health
```
Makes a GET request, prints the response body.

```bash
# POST request with JSON body
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

| Flag | Full Name | What It Does |
|------|-----------|-------------|
| `-X POST` | `--request POST` | Sets the HTTP method (GET, POST, PUT, DELETE) |
| `-H` | `--header` | Adds a request header (e.g., Content-Type, Authorization) |
| `-d` | `--data` | Sends request body (implies POST if -X not specified) |

### Verbose Mode (See Everything)

```bash
curl -v https://app.johndesiventures.website/health
```

| Flag | What It Shows |
|------|--------------|
| `-v` | EVERYTHING: DNS resolution, TCP connection, TLS handshake, request headers sent, response headers received, response body |

**Output explained:**
```
* Host was resolved.                          ← DNS lookup succeeded
* IPv4: 52.x.x.x                             ← IP address resolved to
*   Trying 52.x.x.x:443...                   ← Attempting TCP connection
* Connected to app.johndesiventures.website    ← TCP connection established
* SSL connection using TLSv1.3                ← TLS handshake succeeded
> GET /health HTTP/1.1                        ← Request we SENT (> = outgoing)
> Host: app.johndesiventures.website
< HTTP/1.1 200 OK                            ← Response we RECEIVED (< = incoming)
< content-type: application/json
{"status":"ok"}                               ← Response body
```

Lines starting with `*` = connection info, `>` = what you sent, `<` = what server returned.

### Silent Mode (Scripts/Automation)

```bash
# Silent — no progress bar, just the body
curl -s https://app.johndesiventures.website/health

# Silent + only HTTP status code
curl -s -o /dev/null -w "%{http_code}" https://app.johndesiventures.website/health
# Output: 200
```

| Flag | What It Does |
|------|-------------|
| `-s` | Silent mode — hides progress bar and error messages |
| `-o /dev/null` | Discard the response body (send to nowhere) |
| `-w "%{http_code}"` | Print ONLY the HTTP status code |

### Check Headers Without Body

```bash
# HEAD request (just headers, no body)
curl -I https://app.johndesiventures.website/health

# GET but show headers + body
curl -i https://app.johndesiventures.website/health
```

| Flag | What It Does |
|------|-------------|
| `-I` | Send a HEAD request (only returns headers, no body) |
| `-i` | Include response headers in the output (before the body) |

### Skip SSL Verification

```bash
# Ignore SSL certificate errors (self-signed certs, expired certs)
curl -sk https://church-cms-dev-alb-XXXXX.us-east-1.elb.amazonaws.com/health
```

| Flag | What It Does |
|------|-------------|
| `-k` | `--insecure` — skips SSL certificate verification. Use when hitting ALB directly (cert is for domain, not ALB hostname) |

### Follow Redirects

```bash
# Follow HTTP redirects (301, 302)
curl -L http://app.johndesiventures.website/health
```

| Flag | What It Does |
|------|-------------|
| `-L` | `--location` — follows redirects automatically (e.g., HTTP → HTTPS redirect) |

### Timeout

```bash
# Fail if no response within 5 seconds
curl --max-time 5 https://app.johndesiventures.website/health
```

| Flag | What It Does |
|------|-------------|
| `--max-time 5` | Abort if total time exceeds 5 seconds |
| `--connect-timeout 3` | Abort if TCP connection takes > 3 seconds (separate from response time) |

### Authenticated Requests

```bash
# With Bearer token
curl -H "Authorization: Bearer eyJ..." https://app.johndesiventures.website/api/members
```

### Real Debugging Patterns Used in This Project

```bash
# Pattern 1: Check if app is alive
curl -s https://app.johndesiventures.website/health

# Pattern 2: Check if DB is connected
curl -s https://app.johndesiventures.website/ready

# Pattern 3: Test login (proves auth + DB + app logic all work)
curl -s -X POST https://app.johndesiventures.website/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Pattern 4: Bypass domain — hit ALB directly (isolates DNS from app)
curl -sk https://church-cms-prod-alb-XXXXX.us-east-1.elb.amazonaws.com/health

# Pattern 5: Check DNS resolution
curl -v https://app.johndesiventures.website/health 2>&1 | grep "Could not resolve"
# If this appears → DNS is the problem, not the app

# Pattern 6: Check security headers
curl -sI https://app.johndesiventures.website/health | grep -i "x-content-type\|x-frame\|strict-transport"
```

---

## AWS CLI — Infrastructure Debugging

### ECS (Containers)

```bash
# Is the service running? How many tasks?
aws ecs describe-services \
  --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].{desired:desiredCount,running:runningCount,status:status}'
```

| Part | What It Does |
|------|-------------|
| `describe-services` | Gets service details (task count, status, events) |
| `--cluster` | Which ECS cluster to query |
| `--services` | Which service within that cluster |
| `--query` | JMESPath filter — extracts specific fields from the JSON response |
| `--output table` | Formats output as a readable table (also: json, text) |

```bash
# What are the recent events? (shows deployments, failures)
aws ecs describe-services \
  --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].events[:5].message' \
  --output text
```

```bash
# List running tasks (get task ARNs)
aws ecs list-tasks \
  --cluster church-cms-prod-cluster \
  --service-name church-cms-prod-service \
  --query 'taskArns' --output text
```

```bash
# Kill a task (chaos engineering / testing)
aws ecs stop-task \
  --cluster church-cms-prod-cluster \
  --task "arn:aws:ecs:...:task/TASK_ID" \
  --reason "Debugging - testing self-healing"
```

```bash
# Force a new deployment (pull latest image)
aws ecs update-service \
  --cluster church-cms-prod-cluster \
  --service church-cms-prod-service \
  --force-new-deployment
```

```bash
# Scale to 0 (stop all tasks without destroying infra)
aws ecs update-service \
  --cluster church-cms-prod-cluster \
  --service church-cms-prod-service \
  --desired-count 0
```

### CloudWatch Logs

```bash
# Tail logs (like docker compose logs -f)
aws logs tail /ecs/church-cms-prod --follow
```

| Flag | What It Does |
|------|-------------|
| `--follow` | Stream new logs in real-time (Ctrl+C to stop) |
| `--since 10m` | Only show logs from the last 10 minutes |
| `--since 1h` | Last 1 hour |
| `--filter-pattern "error"` | Only show lines containing "error" |
| `--format short` | Shorter output (no log stream name prefix) |

```bash
# Search for specific patterns
aws logs filter-log-events \
  --log-group-name /ecs/church-cms-prod \
  --filter-pattern "Failed login" \
  --start-time $(date -u -v-1H +%s)000 \
  --query 'events[*].message' --output text
```

| Part | What It Does |
|------|-------------|
| `filter-log-events` | Searches log content (like grep for CloudWatch) |
| `--filter-pattern` | Text to search for (supports patterns) |
| `--start-time` | Unix timestamp in milliseconds (the `000` adds ms) |

### CloudWatch Metrics

```bash
aws cloudwatch get-metric-statistics \
  --namespace "AWS/ECS" \
  --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=church-cms-prod-cluster Name=ServiceName,Value=church-cms-prod-service \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average \
  --output table
```

| Flag | What It Does |
|------|-------------|
| `--namespace` | AWS service providing the metric (ECS, ALB, RDS) |
| `--metric-name` | Specific metric (CPUUtilization, RequestCount, etc.) |
| `--dimensions` | Filters (which cluster, which service) |
| `--start-time` / `--end-time` | Time range to query |
| `--period 300` | Aggregate into 5-minute buckets (300 seconds) |
| `--statistics Average` | What to calculate (Average, Sum, Maximum, Minimum, p95) |

### RDS (Database)

```bash
# Is the database running?
aws rds describe-db-instances \
  --db-instance-identifier church-cms-prod-db \
  --query 'DBInstances[0].{Status:DBInstanceStatus,MultiAZ:MultiAZ,Public:PubliclyAccessible}'
```

```bash
# Disable deletion protection (when you need to destroy)
aws rds modify-db-instance \
  --db-instance-identifier church-cms-prod-db \
  --no-deletion-protection \
  --apply-immediately
```

### ALB (Load Balancer)

```bash
# Get the ALB DNS name
aws elbv2 describe-load-balancers \
  --names church-cms-prod-alb \
  --query 'LoadBalancers[0].DNSName' --output text
```

```bash
# Check target health (are ECS tasks healthy from ALB's perspective?)
TG_ARN=$(aws elbv2 describe-target-groups --names church-cms-prod-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn $TG_ARN
```

### Secrets Manager

```bash
# Restore a deleted secret (7-day recovery window)
aws secretsmanager restore-secret --secret-id "church-cms/dev/database-url"
```

### ACM (Certificates)

```bash
# Check certificate validation status
aws acm describe-certificate \
  --certificate-arn "arn:aws:acm:..." \
  --query 'Certificate.Status' --output text
# Expected: ISSUED (if PENDING_VALIDATION → DNS record missing/wrong)
```

### Security Groups

```bash
# What ports are open? (security audit)
aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=church-cms-prod-alb-sg" \
  --query 'SecurityGroups[0].IpPermissions[*].{Port:FromPort,Source:IpRanges[0].CidrIp}'
```

---

## Docker — Container Debugging

### Container Status

```bash
# What's running?
docker compose ps

# Just the health status
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```

### Logs

```bash
# All logs
docker compose logs

# Follow specific service
docker compose logs -f app

# Last 50 lines
docker compose logs --tail 50 app
```

| Flag | What It Does |
|------|-------------|
| `-f` | Follow (stream new logs in real-time) |
| `--tail 50` | Only show last 50 lines |
| `app` | Service name (from docker-compose.yml) |

### Execute Commands Inside a Running Container

```bash
# Get a shell inside the container
docker compose exec app sh

# Run a one-off command
docker compose exec app node db/migrate.js

# Run the health check manually (debug health check failures)
docker compose exec app wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health
```

| Part | What It Does |
|------|-------------|
| `exec` | Run a command in a RUNNING container |
| `run` | Start a NEW container and run a command (then exit) |
| `app` | Service name from docker-compose.yml |
| `sh` | The command to run (shell in this case) |

### Restart and Rebuild

```bash
# Restart a service (keeps container, restarts process)
docker compose restart app

# Stop and recreate (rebuilds from image)
docker compose up -d --force-recreate app

# Full rebuild (including Dockerfile changes)
docker compose up -d --build app
```

### Inspect Container Details

```bash
# See environment variables inside the container
docker compose exec app env

# See the running process
docker compose exec app ps aux

# Check memory/CPU usage
docker stats
```

---

## Terraform — IaC Debugging

```bash
# What resources exist in state?
terraform state list

# Show details of a specific resource
terraform state show module.ecs.aws_ecs_service.app

# Preview changes without applying
terraform plan

# Import an existing resource into state
terraform import 'module.secrets.aws_secretsmanager_secret.database_url' "arn:aws:..."

# Target a specific module (only plan/apply that module)
terraform plan -target=module.vpc
terraform apply -target=module.alb

# Show outputs
terraform output
terraform output alb_raw_dns

# Refresh state (sync with actual AWS state)
terraform refresh

# Unlock state (if a previous apply crashed mid-way)
terraform force-unlock LOCK_ID
```

| Command | When to Use |
|---------|-------------|
| `state list` | "What does Terraform think exists?" |
| `state show` | "What are the details of this resource?" |
| `plan -target` | "I only want to change ONE module" |
| `import` | "This resource exists in AWS but not in Terraform state" |
| `refresh` | "State is out of sync with reality" |
| `force-unlock` | "Previous apply crashed, state is locked" |

---

## Git — Pipeline Debugging

```bash
# See what branch you're on
git branch --show-current

# See recent commits (is the right code deployed?)
git log --oneline -10

# Check what triggered the CI failure
gh run list --limit 5
gh run view <run-id> --log-failed

# Re-run a failed workflow
gh run rerun <run-id>
```

---

## DNS — Network Debugging

```bash
# Resolve a domain name (did DNS propagate?)
dig churchidea.johndesiventures.website

# Just the IP/CNAME answer
dig +short churchidea.johndesiventures.website

# Check a specific record type
dig CNAME churchidea.johndesiventures.website

# Use a specific DNS server (bypass cache)
dig @8.8.8.8 churchidea.johndesiventures.website

# Check if a port is open
nc -zv app.johndesiventures.website 443
```

| Command | What It Does |
|---------|-------------|
| `dig` | DNS lookup — shows what IP/CNAME a domain resolves to |
| `dig +short` | Just the answer, no extra info |
| `dig @8.8.8.8` | Ask Google's DNS (bypasses local cache) |
| `nc -zv host port` | Test if a TCP port is reachable (without sending data) |

---

## The Debugging Playbook

### "App is unreachable"

```
Step 1: Is DNS working?
  dig app.johndesiventures.website
  → No answer? DNS CNAME not configured.

Step 2: Is the ALB responding?
  curl -sk https://<ALB-DNS>/health
  → Connection refused? ALB or security group issue.

Step 3: Are ECS tasks running?
  aws ecs describe-services --cluster ... --query '..runningCount'
  → 0 running? Check service events for why.

Step 4: Are tasks healthy from ALB's perspective?
  aws elbv2 describe-target-health --target-group-arn ...
  → Unhealthy? Check container logs.

Step 5: What do the logs say?
  aws logs tail /ecs/church-cms-prod --since 5m
```

### "App loads but login fails"

```
Step 1: Hit health directly
  curl -s https://app.johndesiventures.website/health → 200? App is alive.

Step 2: Hit ready endpoint
  curl -s https://app.johndesiventures.website/ready → "database":"connected"? DB is fine.

Step 3: Try login via curl (bypass browser)
  curl -s -X POST .../api/login -d '...' → Token returned? Backend works.
  → If backend works but browser fails: DNS, CORS, or mixed content issue.

Step 4: If login fails via curl too
  → Check logs: aws logs tail ... --filter-pattern "error"
  → Likely: migrations not run (no tables), or wrong DATABASE_URL
```

### "Deployment failed"

```
Step 1: Check CI logs
  gh run view <id> --log-failed
  → Lint error? Test failure? Build failure?

Step 2: Check ECS service events
  aws ecs describe-services --cluster ... --query 'services[0].events[:5]'
  → "unable to pull secrets"? Secrets Manager issue.
  → "CannotPullContainerError"? Image doesn't exist or wrong tag.

Step 3: Check task stopped reason
  aws ecs describe-tasks --cluster ... --tasks <task-arn> \
    --query 'tasks[0].stoppedReason'
  → "OutOfMemoryError"? Increase memory in task definition.
  → "HealthCheckError"? App is crashing on startup — check logs.
```

### "Response is slow"

```
Step 1: Check response time
  curl -w "\n%{time_total}s\n" -s https://app.johndesiventures.website/api/members
  → > 2 seconds? Something is wrong.

Step 2: Check ECS CPU
  aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name CPUUtilization ...
  → > 80%? Need more tasks or bigger CPU.

Step 3: Check RDS
  aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name CPUUtilization ...
  → High? Slow query. Check database connections too.

Step 4: Check logs for slow queries
  aws logs tail ... --filter-pattern "slow\|timeout\|connection"
```

---

## Command Flags Quick Reference

| Flag | Used With | Meaning |
|------|-----------|---------|
| `-s` | curl | Silent (no progress bar) |
| `-v` | curl | Verbose (show everything) |
| `-k` | curl | Skip SSL verification |
| `-L` | curl | Follow redirects |
| `-I` | curl | HEAD request only (just headers) |
| `-i` | curl | Include headers in output |
| `-X` | curl | HTTP method (GET, POST, PUT, DELETE) |
| `-H` | curl | Add a header |
| `-d` | curl | Send body data |
| `-o` | curl | Output to file (or /dev/null to discard) |
| `-w` | curl | Custom output format (status code, time, etc.) |
| `-f` | docker logs | Follow (real-time stream) |
| `--tail` | docker logs | Last N lines |
| `--follow` | aws logs | Real-time streaming |
| `--since` | aws logs | Time filter |
| `--query` | aws cli | JMESPath filter (extract specific fields) |
| `--output` | aws cli | Format: json, table, text |
| `--filter-pattern` | aws logs | Text search pattern |
| `-target` | terraform | Only apply to specific resource/module |
| `+short` | dig | Just the answer |

---
