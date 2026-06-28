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

## Issue #6: Terraform Init Fails — AWS Provider Download Timeout/Failure

**Date:** June 25, 2026  
**Environment:** Local development (macOS darwin_amd64, Terraform v1.5.7)  
**Severity:** Blocks all infrastructure deployment

### Symptoms

- `terraform init` hangs during "Installing hashicorp/aws..."
- Eventually fails with: `Error while installing hashicorp/aws v5.100.0: provider binary not found`
- Or: `could not find executable file starting with terraform-provider-aws`
- Registry IS reachable (curl to registry.terraform.io works)
- The issue is downloading the ~350-400MB provider binary

### Root Cause

The AWS Terraform provider binary is very large (~350-400MB for v5.100.0). On slow or constrained network connections (VPN, throttled ISP, Kiro terminal sessions), the download times out or gets corrupted before completing.

Additionally, `terraform init` doesn't resume failed downloads — it starts from zero every time.

### Resolution

**Step 1: Pin a specific (smaller) provider version**

Change `~> 5.0` (which resolves to the latest, largest version) to a specific pinned version:

```hcl
required_providers {
  aws = {
    source  = "hashicorp/aws"
    version = "5.31.0"  # Pinned — smaller than 5.100.0
  }
}
```

**Step 2: Manually download the provider binary**

Download via browser (faster, resumable) from:
```
https://releases.hashicorp.com/terraform-provider-aws/5.31.0/terraform-provider-aws_5.31.0_darwin_amd64.zip
```

Or via curl in your terminal (not through an IDE terminal which may have network limits):
```bash
curl -L -o /tmp/terraform-provider-aws.zip \
  "https://releases.hashicorp.com/terraform-provider-aws/5.31.0/terraform-provider-aws_5.31.0_darwin_amd64.zip"
```

**Step 3: Create the filesystem mirror directory**

```bash
mkdir -p ~/.terraform.d/plugins/registry.terraform.io/hashicorp/aws/5.31.0/darwin_amd64

unzip /tmp/terraform-provider-aws.zip \
  -d ~/.terraform.d/plugins/registry.terraform.io/hashicorp/aws/5.31.0/darwin_amd64/

chmod +x ~/.terraform.d/plugins/registry.terraform.io/hashicorp/aws/5.31.0/darwin_amd64/terraform-provider-aws_*
```

**Step 4: Init with the filesystem mirror**

```bash
cd infrastructure/terraform/environments/dev
rm -rf .terraform .terraform.lock.hcl
terraform init -plugin-dir=/Users/bankolejohn/.terraform.d/plugins
```

### Critical Gotcha: ~ Does Not Expand in -plugin-dir

```bash
# WRONG — Terraform takes this literally, looks for a directory called "~"
terraform init -plugin-dir=~/.terraform.d/plugins
# Error: cannot search ~/.terraform.d/plugins: lstat ~/.terraform.d/plugins: no such file or directory

# CORRECT — use the full absolute path
terraform init -plugin-dir=/Users/bankolejohn/.terraform.d/plugins
```

The `~` shorthand is a SHELL feature (bash/zsh expands it before passing to the program). But when Terraform receives `-plugin-dir=~/.terraform.d/plugins` as a flag value, it interprets the `~` as a literal character, not your home directory.

This applies to ANY CLI tool that takes a path as a flag value. Always use absolute paths in flag arguments.

### Prevention

1. **Pin provider versions** — don't use `~> 5.0` which always resolves to the latest (and largest). Pin to a specific version you've tested.

2. **Use a provider cache** — set `TF_PLUGIN_CACHE_DIR` in your shell profile:
   ```bash
   # Add to ~/.zshrc
   export TF_PLUGIN_CACHE_DIR="$HOME/.terraform.d/plugin-cache"
   mkdir -p $TF_PLUGIN_CACHE_DIR
   ```
   This caches downloaded providers so they're only downloaded once across all projects.

3. **Filesystem mirror for CI/teams** — for teams with slow connections or air-gapped environments, maintain a shared filesystem mirror:
   ```hcl
   # In ~/.terraformrc or terraform.rc
   provider_installation {
     filesystem_mirror {
       path    = "/path/to/shared/mirror"
       include = ["registry.terraform.io/hashicorp/*"]
     }
     direct {
       exclude = ["registry.terraform.io/hashicorp/*"]
     }
   }
   ```

### Lesson Learned

- Terraform provider downloads are the #1 friction point for new team members and CI pipelines
- Always pin provider versions in production code (reproducibility + smaller downloads)
- The `~` expansion issue is subtle and wastes hours — always use `$HOME` or absolute paths in scripts and flag arguments
- In a real company: you'd set up a Terraform provider mirror (Artifactory, S3, or filesystem) so the team never downloads from the internet directly

---

## Issue #7: App Serves Frontend But Login Fails — "Connection Error"

**Date:** June 28, 2026  
**Environment:** AWS ECS Fargate (dev), accessed via HTTPS  
**Severity:** App appears broken to users (can see login page but can't log in)

### Symptoms

- The app's login page loads correctly in the browser (HTML/CSS/JS served fine)
- Entering credentials and clicking Login shows: "Connection error. Please try again."
- The error is a generic frontend error — no specific HTTP status code visible
- The ALB health checks pass (ECS service is "steady state")
- Accessing `/health` and `/ready` directly returns 200 OK

### Investigation Steps

1. **Check ECS service status:**
   ```bash
   aws ecs describe-services --cluster church-cms-dev-cluster --services church-cms-dev-service \
     --query 'services[0].{desired:desiredCount,running:runningCount,status:status}'
   ```
   Result: `running: 1, status: ACTIVE` — container is running fine.

2. **Check health endpoints directly (via ALB DNS, bypassing custom domain):**
   ```bash
   curl -sk https://church-cms-dev-alb-XXXXXXX.us-east-1.elb.amazonaws.com/health
   # {"status":"ok","timestamp":"...","uptime":2317}

   curl -sk https://church-cms-dev-alb-XXXXXXX.us-east-1.elb.amazonaws.com/ready
   # {"status":"ready","database":"connected"}
   ```
   Result: App AND database are working perfectly.

3. **Test login API directly:**
   ```bash
   curl -sk -X POST https://church-cms-dev-alb-XXXXXXX.us-east-1.elb.amazonaws.com/api/login \
     -H "Content-Type: application/json" \
     -d '{"username":"admin","password":"admin123"}'
   # {"token":"eyJ...","user":{"id":1,"username":"admin","role":"main_leader"}}
   ```
   Result: Login works. Token is returned. The app backend is fully functional.

4. **The actual problem:** DNS for the custom domain wasn't resolving:
   ```bash
   curl -v https://churchidea.johndesiventures.website/health
   # Could not resolve host: churchidea.johndesiventures.website
   ```

### Root Cause

**Two issues combined:**

1. **Database migrations hadn't been run.** The app started but had no tables — login queries returned errors. Fixed by running a one-off ECS task with migration commands.

2. **DNS CNAME for the custom domain wasn't configured.** The ACM certificate was validated (for HTTPS), but the actual `churchidea` CNAME pointing to the ALB wasn't added in Namecheap. The browser loaded a cached version of the page, but API calls to the domain failed because DNS wasn't resolving.

### Resolution

**Step 1: Run database migrations (one-off ECS task):**
```bash
SUBNET=$(aws ec2 describe-subnets --filters "Name=tag:Name,Values=church-cms-dev-public-1" \
  --query 'Subnets[0].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups --filters "Name=tag:Name,Values=church-cms-dev-ecs-sg" \
  --query 'SecurityGroups[0].GroupId' --output text)

aws ecs run-task \
  --cluster church-cms-dev-cluster \
  --task-definition church-cms-dev \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"church-cms-app","command":["sh","-c","node db/migrate.js && node db/seed.js"]}]}'
```

**Step 2: Add DNS CNAME record in Namecheap:**

| Type | Host | Target |
|------|------|--------|
| CNAME | `churchidea` | `church-cms-dev-alb-XXXXXXX.us-east-1.elb.amazonaws.com` |

**Step 3: Wait 2-5 minutes for DNS propagation, then hard-refresh browser (Cmd+Shift+R)**

### Key Debugging Lesson

When an app "loads but doesn't work," there are usually two layers:
- **Static assets (HTML/CSS/JS):** Served from the container's `/public` folder via Express static middleware. These work as long as the container is running.
- **API calls (login, data fetching):** Require the FULL stack: container → database → response. These break independently of the frontend.

Always test the API layer directly with `curl` before assuming the app is broken:
```bash
curl -sk https://<ALB-DNS>/health   # Is the container alive?
curl -sk https://<ALB-DNS>/ready    # Is the database connected?
curl -sk -X POST https://<ALB-DNS>/api/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'  # Does auth work?
```

If ALL three return 200 but the browser shows errors → the problem is DNS, CORS, or mixed content — NOT the app.

### DNS Records Required (Summary)

After deploying with Terraform, you need TWO DNS records in Namecheap:

| Purpose | Type | Host | Target |
|---------|------|------|--------|
| ACM Certificate Validation | CNAME | `_xxxxx.churchidea` | `_yyyyy.acm-validations.aws.` |
| Route traffic to ALB | CNAME | `churchidea` | `church-cms-dev-alb-XXXXX.us-east-1.elb.amazonaws.com` |

The first proves domain ownership (required for HTTPS). The second routes actual user traffic.

---
