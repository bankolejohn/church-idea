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
- Consider using Terraform's `null_resource` with a local-exec provisioner to verify secret availability before creating the ECS service
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
