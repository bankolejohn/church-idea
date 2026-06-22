# Troubleshooting Guide

Production issues encountered during deployment and their resolutions.

---

## Issue #1: ECS Tasks Failing to Start — Secret Retrieval Error

**Date:** June 15, 2026  
**Environment:** AWS ECS Fargate (dev)  
**Severity:** Service outage — 0 running tasks

### Symptoms

- ECS service `desiredCount: 1`, `runningCount: 0`
- Deployment `rolloutState: FAILED`
- Service events showed `ResourceInitializationError`

### Root Cause

Race condition during initial `terraform apply`. The ECS service attempted to start tasks before Secrets Manager had finished populating the `DATABASE_URL` secret with the RDS endpoint value. The RDS instance takes ~7 minutes to provision, and the secret value depends on the RDS endpoint.

### Error Message

```
ResourceInitializationError: unable to pull secrets or registry auth: 
execution resource retrieval failed: unable to retrieve secret from asm: 
service call has been retried 1 time(s): failed to fetch secret 
arn:aws:secretsmanager:us-east-1:***:secret:church-cms/dev/database-url-LB1bMG 
from secrets manager: ResourceNotFoundException: Secrets Manager can't find 
the specified secret value for staging label: AWSCURRENT
```

### Resolution

Force a new deployment after all resources have finished provisioning:

```bash
aws ecs update-service \
  --cluster church-cms-dev-cluster \
  --service church-cms-dev-service \
  --force-new-deployment
```

### Prevention

- Use `depends_on` in Terraform to ensure RDS is fully provisioned before secrets are created
- Consider using a Terraform `null_resource` with a local-exec provisioner to verify secret availability before creating the ECS service
- Implement retry logic in the application for database connection on startup

---

## Issue #2: Application UI Broken — CSS and JavaScript Not Loading

**Date:** June 15, 2026  
**Environment:** AWS ECS behind ALB (HTTP only, no SSL certificate)  
**Severity:** Application unusable — visible to end users

### Symptoms

- HTML loads but renders without any styling (raw unstyled page)
- Login form visible but after submitting, browser shows "Connection error"
- Browser DevTools shows sub-resource requests being upgraded to HTTPS and failing
- `ERR_CONNECTION_REFUSED` on all HTTPS requests

### Root Cause

Two Helmet.js security headers were forcing the browser to upgrade all HTTP traffic to HTTPS, even though the ALB only had an HTTP listener (port 80, no SSL certificate):

1. **`Strict-Transport-Security: max-age=15552000`** — Told the browser "always use HTTPS for this domain for the next 180 days"
2. **`Content-Security-Policy: ... upgrade-insecure-requests`** — Told the browser "convert every HTTP request to HTTPS before sending it"

**The sequence of failure:**

```
1. Browser requests http://alb-url/ → Gets HTML (200 OK)
2. Response includes headers:
   - Strict-Transport-Security: max-age=15552000
   - Content-Security-Policy: ...upgrade-insecure-requests
3. Browser parses HTML, finds <link href="styles.css">
4. Browser upgrades request to https://alb-url/styles.css
5. ALB has no HTTPS listener → Connection refused
6. CSS fails to load → Page renders unstyled
7. Same for app.js → No JavaScript functionality
8. Login form submits via fetch() → Also upgraded to HTTPS → Fails
9. User sees "Connection error"
```

### Investigation Steps

```bash
# Step 1: Verify the server IS returning CSS correctly
curl -sI http://church-cms-dev-alb-*.elb.amazonaws.com/styles.css
# Result: HTTP/1.1 200 OK, Content-Type: text/css ✅

# Step 2: Check response headers for HTTPS enforcement
curl -sI http://church-cms-dev-alb-*.elb.amazonaws.com/ | grep -i "strict-transport"
# Result: Strict-Transport-Security: max-age=15552000; includeSubDomains ❌

# Step 3: Check CSP for upgrade-insecure-requests
curl -sI http://church-cms-dev-alb-*.elb.amazonaws.com/ | grep -i "content-security-policy"
# Result: ...upgrade-insecure-requests ❌

# Step 4: Confirm the problem is header-driven, not missing files
curl -s http://church-cms-dev-alb-*.elb.amazonaws.com/styles.css | head -5
# Result: Returns valid CSS content ✅
```

### Resolution

Made both HSTS and `upgrade-insecure-requests` conditional on the `ENABLE_HTTPS` environment variable:

```javascript
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            // ... other directives ...
            upgradeInsecureRequests: process.env.ENABLE_HTTPS === 'true' ? [] : null
        }
    },
    strictTransportSecurity: process.env.ENABLE_HTTPS === 'true'
        ? { maxAge: 15552000, includeSubDomains: true }
        : false
}));
```

**After deploying the fix, browser HSTS cache must be cleared:**

- Chrome: `chrome://net-internals/#hsts` → Delete domain → re-enter domain
- Safari: Clear all website data
- Firefox: Clear site data for the domain
- Or: Test in incognito/private window

### Prevention

- Never enable HSTS or `upgrade-insecure-requests` unless HTTPS is actually configured
- Gate security headers behind environment configuration
- Test with `curl -sI` before testing in browser (curl doesn't cache HSTS)
- When deploying to HTTP-only environments (dev without SSL), explicitly disable HTTPS enforcement
- Add SSL certificate to ALB before enabling these headers in production

### Key Lesson

Security headers are powerful — they can make your application completely inaccessible if they don't match your actual infrastructure. Always verify your transport layer (HTTP vs HTTPS) matches what your security headers declare.

---

## Issue #3: Database Migrations Not Running on ECS

**Date:** June 15, 2026  
**Environment:** AWS ECS Fargate  
**Severity:** Application error — 500 on all API routes

### Symptoms

- `/health` returns 200 (app is alive)
- `/ready` returns 200 (database connected)
- All API routes return `{"error": "Internal server error"}`
- Login fails with 500

### Root Cause

ECS runs the application container (`node server.js`), but database tables don't exist yet. Migrations need to be run separately as a one-off task.

### Resolution

Run migrations as a one-off ECS task with a command override:

```bash
# Get the network config
SUBNET=$(aws ec2 describe-subnets --filters "Name=tag:Name,Values=church-cms-dev-public-1" --query 'Subnets[0].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups --filters "Name=tag:Name,Values=church-cms-dev-ecs-sg" --query 'SecurityGroups[0].GroupId' --output text)

# Run migration as one-off task
aws ecs run-task \
  --cluster church-cms-dev-cluster \
  --task-definition church-cms-dev:1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"church-cms-app","command":["sh","-c","node db/migrate.js && node db/seed.js"]}]}'

# Verify it completed successfully (exit code 0)
aws ecs describe-tasks --cluster church-cms-dev-cluster --tasks <TASK_ARN> \
  --query 'tasks[0].containers[0].exitCode'
```

### Prevention

- Add migration as a step in the CD pipeline before updating the ECS service
- Consider using an init container or entrypoint script that runs migrations on startup
- For production, migrations should be run as a separate pipeline step with rollback capability

---

## Issue #4: Terraform Partial Failure — Secrets Already Scheduled for Deletion

**Date:** June 16, 2026  
**Environment:** AWS (Terraform apply)  
**Severity:** Deployment blocked

### Symptoms

- `terraform apply` partially succeeds (VPC, ALB, ECS, RDS created)
- Secrets Manager resources fail with error:
  ```
  InvalidRequestException: You can't create this secret because a secret 
  with this name is already scheduled for deletion.
  ```

### Root Cause

AWS Secrets Manager retains deleted secrets for 7-30 days (recovery window). When you `terraform destroy` an environment and then try to recreate it, the secret names conflict because the old ones haven't been fully purged yet.

### Resolution

```bash
# Step 1: Restore the deleted secrets
aws secretsmanager restore-secret --secret-id "church-cms/dev/database-url"
aws secretsmanager restore-secret --secret-id "church-cms/dev/jwt-secret"

# Step 2: Import them into Terraform state
terraform import 'module.secrets.aws_secretsmanager_secret.database_url' '<SECRET_ARN>'
terraform import 'module.secrets.aws_secretsmanager_secret.jwt_secret' '<SECRET_ARN>'

# Step 3: Apply again (Terraform now manages the existing secrets)
terraform apply
```

### Prevention

- Use `recovery_window_in_days = 0` in the Terraform resource for dev environments (immediate deletion)
- Or use unique names with timestamps/random suffixes
- Or wait 7 days before recreating the same environment

### Key Concept: Terraform Partial Apply

Terraform does NOT work like a database transaction. It creates resources independently based on a dependency graph. If resource A fails:
- Resources that don't depend on A: already created successfully
- Resources that depend on A: skipped

Running `terraform apply` again only retries the failed resources. Terraform state tracks what exists and what doesn't.

---

## Issue #5: ACM Certificate Not Validated — HTTPS Listener Fails

**Date:** June 16, 2026  
**Environment:** AWS ALB  
**Severity:** HTTPS not available

### Symptoms

- `terraform apply` fails on the HTTPS listener with:
  ```
  UnsupportedCertificate: The certificate must have a fully-qualified domain name,
  a supported signature, and a supported key size.
  ```
- Certificate status: `PENDING_VALIDATION`

### Root Cause

ACM certificates require DNS validation. You must add a CNAME record to your DNS provider to prove domain ownership. Until the record propagates and AWS validates it, the certificate status stays `PENDING_VALIDATION` and can't be attached to a load balancer.

### Resolution

```bash
# Step 1: Get the validation DNS record
aws acm describe-certificate --certificate-arn <CERT_ARN> \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'

# Step 2: Add the CNAME record to your DNS provider (Namecheap, Route53, etc.)
# Host: _<hash>.subdomain (without the root domain suffix)
# Value: _<hash>.<hash>.acm-validations.aws.

# Step 3: Wait for validation (5-15 minutes)
aws acm describe-certificate --certificate-arn <CERT_ARN> \
  --query 'Certificate.Status'
# Wait until output is: "ISSUED"

# Step 4: Run terraform apply again
terraform apply
```

### Timeline

```
1. terraform apply creates ACM certificate → Status: PENDING_VALIDATION
2. Terraform outputs the DNS validation record
3. You add CNAME to DNS provider
4. AWS checks DNS (5-15 min) → Status: ISSUED
5. terraform apply again → HTTPS listener created successfully
```

### Prevention

- Create the ACM certificate as a separate step before the main infrastructure
- Use Route53 (AWS DNS) instead of external DNS for automatic validation
- Accept that first deploy always requires this manual DNS step

---

## Issue #6: Terraform count Depends on Unknown Value

**Date:** June 16, 2026  
**Environment:** Terraform plan  
**Severity:** Plan/apply blocked

### Symptoms

```
Error: Invalid count argument
The "count" value depends on resource attributes that cannot be determined
until apply, so Terraform cannot predict how many instances will be created.
```

### Root Cause

Using a resource attribute (like `aws_acm_certificate.app.arn != ""`) in a `count` argument. Terraform needs to know `count` at plan time, but the ARN isn't known until the resource is actually created.

### Resolution

Use a separate boolean variable instead of deriving the count from a resource attribute:

```hcl
# BAD: count depends on unknown resource attribute
count = var.certificate_arn != "" ? 1 : 0

# GOOD: count depends on a known variable
variable "enable_https" {
  type    = bool
  default = false
}
count = var.enable_https ? 1 : 0
```

### Key Concept

Terraform's `count` and `for_each` must be deterministic at plan time. They can depend on:
- Variables ✅
- Locals that use only variables ✅
- Data sources ✅

They cannot depend on:
- Resource attributes that don't exist yet ❌
- Outputs from other modules that haven't been applied ❌

## Issue #4: OpenTelemetry SDK 2.x Breaking Change — Resource Constructor Removed

**Date:** June 22, 2026  
**Environment:** Docker (local development)  
**Severity:** Application crash on startup

### Symptoms

- Container starts, immediately crashes
- Exit code 1
- No health check passes (container marked unhealthy)

### Error Message

```
/app/lib/telemetry.js:62
const resource = new Resource({
                 ^

TypeError: Resource is not a constructor
    at Object.<anonymous> (/app/lib/telemetry.js:62:18)
```

### Root Cause

OpenTelemetry JS SDK 2.x (released February 2025) introduced a breaking change: the `Resource` class is no longer exported from `@opentelemetry/resources`. The package now exports utility functions instead.

This is part of a broader trend in the OTel JS project — moving away from exported classes toward factory functions to allow internal refactoring without breaking public API.

### Resolution

```javascript
// Before (SDK 1.x):
const { Resource } = require('@opentelemetry/resources');
const resource = new Resource({ ... });

// After (SDK 2.x):
const { resourceFromAttributes } = require('@opentelemetry/resources');
const resource = resourceFromAttributes({ ... });
```

### Lesson Learned

- Always check migration/upgrade guides when using major versions of open-source libraries
- The OTel JS 2.x upgrade guide is at: https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md
- Pin major versions in package.json to avoid surprise breakages (`"@opentelemetry/resources": "^2.0.0"` not `"*"`)

---

## Issue #5: Docker Health Check Fails — Alpine Linux IPv6 Resolution

**Date:** June 22, 2026  
**Environment:** Docker (local development with monitoring stack)  
**Severity:** All monitoring services fail to start (dependency on app health)

### Symptoms

- App container starts successfully (logs show "Server started")
- OpenTelemetry initializes correctly
- Docker marks container as "unhealthy" after start_period
- Monitoring services (Prometheus, Grafana) refuse to start with: `dependency failed to start: container church-idea-app-1 is unhealthy`
- Confusing because the app IS running — you can `curl` it from the host

### Error Message

```
dependency failed to start: container church-idea-app-1 is unhealthy
```

Running the health check manually inside the container:

```
$ docker compose exec app wget --no-verbose --tries=1 --spider http://localhost:3000/health
Connecting to localhost:3000 ([::1]:3000)
wget: can't connect to remote host: Connection refused
```

### Root Cause

**Alpine Linux resolves `localhost` to `::1` (IPv6 loopback), but Node.js `app.listen(PORT, '0.0.0.0')` only binds to IPv4.**

The chain of events:
1. Node.js starts listening on `0.0.0.0:3000` (IPv4 only)
2. Docker health check runs: `wget http://localhost:3000/health`
3. Alpine's `/etc/hosts` has: `::1 localhost` (IPv6 first)
4. `wget` resolves `localhost` → `[::1]` (IPv6)
5. Tries to connect to `[::1]:3000` → nothing listening there → "Connection refused"
6. Health check fails → Docker marks container unhealthy

**Why this only appeared NOW:**
- Before the monitoring stack, nothing depended on the health check status. The app was "unhealthy" in Docker's eyes the whole time, but no service cared.
- Adding `depends_on: app: condition: service_healthy` in the monitoring compose exposed the latent bug.

### Resolution

Replace `localhost` with `127.0.0.1` in all health check commands:

```yaml
# docker-compose.yml
healthcheck:
  test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:3000/health"]

# Dockerfile
HEALTHCHECK CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1
```

### Alternative Fixes (considered but not chosen)

1. **Listen on `::` (dual-stack):** `app.listen(PORT)` without specifying host — binds to both IPv4 and IPv6. Risk: exposes on IPv6 interfaces which may have different firewall rules.
2. **Modify Alpine's /etc/hosts:** Remove IPv6 localhost entry. Fragile and non-standard.
3. **Use `curl` instead of `wget`:** Same issue — both resolve localhost the same way.

### Lesson Learned

- **Never use `localhost` in Docker health checks.** Always use `127.0.0.1`.
- This bug is SILENT until something depends on the health check status.
- When debugging "container is unhealthy but app is running," run the health check command manually inside the container: `docker compose exec <service> <health-check-command>`
- Test health checks early — don't wait until you add dependent services to discover they've been failing all along.

---
