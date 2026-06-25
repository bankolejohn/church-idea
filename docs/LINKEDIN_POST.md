# LinkedIn Posts

---

## Post 1: Security Headers Breaking HTTP Deployments

**🚨 A Security Header Broke My Entire Application — And No Errors Were Thrown**

Just deployed a Node.js app to AWS ECS behind an Application Load Balancer. Everything looked fine — health checks passing, container running, HTML loading.

But the app was completely broken. No styles. No JavaScript. Login failing silently.

Here's what happened:

I had Helmet.js configured with production-grade security headers. Two of them silently destroyed the user experience:

```
Strict-Transport-Security: max-age=15552000
Content-Security-Policy: ...upgrade-insecure-requests
```

These headers told the browser: "Upgrade every request to HTTPS."

The problem? My ALB only had an HTTP listener. No SSL certificate yet.

So the browser loaded the HTML over HTTP, then tried to fetch CSS, JS, and API calls over HTTPS. All failed silently. No error in the server logs. No 4xx. No 5xx. Just... nothing loaded.

**The debugging process:**

```bash
# Server returning CSS? Yes.
curl -sI http://my-alb-url/styles.css → 200 OK ✅

# But the browser never received it.
# Because it was requesting https://my-alb-url/styles.css → Connection refused
```

`curl` doesn't respect HSTS or CSP. Browsers do. That's why the server looked healthy but users saw a broken page.

**The fix:**

Gate HTTPS enforcement behind an environment variable:
```javascript
strictTransportSecurity: process.env.ENABLE_HTTPS === 'true' ? {...} : false
upgradeInsecureRequests: process.env.ENABLE_HTTPS === 'true' ? [] : null
```

**Lessons for DevOps engineers:**

1. Security headers are infrastructure — they must match your actual transport config
2. Always test with a real browser, not just `curl` — they behave differently
3. HSTS is cached by the browser for the declared max-age. One wrong deployment can lock users out for months
4. Your app can return 200 on every endpoint and still be completely broken from the user's perspective
5. When debugging "works in curl, broken in browser" — check response headers first

This is the kind of issue that doesn't show up in staging when both environments use HTTPS. It only appears when your dev/test environment uses HTTP. Environment parity matters.

---

#DevOps #AWS #ECS #Troubleshooting #Security #WebDevelopment #Helmet #NodeJS #Infrastructure

---

## Post 2: Terraform Partial Failures and HTTPS on AWS ECS

**🔧 Deployed to AWS ECS. Terraform half-succeeded. Secrets conflicted. Certificate wasn't validated. Here's how I recovered without starting over.**

Deploying a Node.js app to AWS ECS with Terraform. Expected a clean `terraform apply`. Got a partial failure instead. Here's what happened and how to handle it like a professional.

**The scenario:**

Running `terraform apply` to create 37 AWS resources: VPC, subnets, ALB, ECS Fargate, RDS PostgreSQL, Secrets Manager, ACM certificate, HTTPS listener.

Result: 28 resources created. 3 failed. Terraform stopped those branches of the dependency graph but everything else succeeded.

**Failure 1: Secrets Manager name conflict**

```
InvalidRequestException: You can't create this secret because a secret 
with this name is already scheduled for deletion.
```

AWS keeps deleted secrets for 7 days. I had destroyed the previous environment, and the secret names were still reserved.

Fix:
```bash
aws secretsmanager restore-secret --secret-id "my-app/dev/database-url"
terraform import 'module.secrets.aws_secretsmanager_secret.database_url' '<ARN>'
terraform apply  # Now manages the existing secret
```

**Failure 2: ACM certificate not yet validated**

The HTTPS listener failed because the SSL certificate was still `PENDING_VALIDATION`. ACM uses DNS validation — I needed to add a CNAME record to my domain registrar first.

Fix:
```bash
# Get the validation record
aws acm describe-certificate --certificate-arn <ARN> \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'

# Add CNAME to DNS provider, wait 5-15 min
# Then:
terraform apply  # HTTPS listener creates successfully
```

**Failure 3: Terraform count depends on unknown value**

```
Error: Invalid count argument — depends on resource attributes 
that cannot be determined until apply
```

I was using `count = var.certificate_arn != "" ? 1 : 0` but the ARN isn't known at plan time.

Fix: Use a separate boolean variable:
```hcl
variable "enable_https" { type = bool }
count = var.enable_https ? 1 : 0
```

**Key takeaways for aspiring DevOps engineers:**

1. Terraform is NOT atomic. Partial failures are normal. Learn to recover, not restart.
2. `terraform import` is your friend — it brings existing resources under Terraform management without recreating them.
3. ACM certificate validation is a two-step process: create cert → add DNS record → wait → apply again. First deploys always need this.
4. AWS Secrets Manager has a 7-day deletion window. Plan for it or set `recovery_window_in_days = 0` in dev.
5. Never use resource attributes in `count`/`for_each` — use variables instead.
6. After partial failure: don't panic, don't `terraform destroy`. Just fix the issue and `apply` again. Terraform knows what exists.

The infra is now running: VPC + ALB + ECS Fargate + RDS + ACM + HTTPS — all defined in code, reproducible, and serving traffic over TLS 1.3.

Total time from first failure to full recovery: 20 minutes. No resources were recreated unnecessarily. That's the power of declarative infrastructure.

---

#DevOps #Terraform #AWS #ECS #Infrastructure #CloudEngineering #IaC #Troubleshooting

---

## Post 3: Terraform Remote State — Why Local State Will Burn You

**Your Terraform state file is more important than your code. Here's why, and how to protect it.**

I just set up remote state (S3 + DynamoDB) for a production Terraform project. Before that, I was running with local state. Here's what I learned about why that's dangerous and how the remote backend actually works.

**What is Terraform state?**

Every time you run `terraform apply`, Terraform writes a state file mapping your code to real AWS resources. Without it, Terraform doesn't know what exists. It's your infrastructure's source of truth.

**Why local state is a ticking time bomb:**

- Laptop dies → you lose track of all deployed resources
- Two engineers apply simultaneously → state corrupts, resources get duplicated
- Accidentally delete the file → Terraform tries to recreate everything (duplicates your entire infra)
- `git add .` → you just committed database passwords to version control

**The fix: S3 + DynamoDB**

```
S3 Bucket → Stores state (encrypted, versioned)
DynamoDB Table → Provides locking (prevents concurrent writes)
```

**The chicken-and-egg problem:**

You need a bucket to store state. But to create a bucket with Terraform, you need somewhere to store state. The solution:

1. Create the backend (S3 + DynamoDB) using local state — once, ever
2. Configure all environments to use the S3 backend going forward
3. Run `terraform init -migrate-state` to move local → remote

**My setup:**

```hcl
backend "s3" {
  bucket         = "my-app-terraform-state-<account-id>"
  key            = "dev/terraform.tfstate"
  region         = "us-east-1"
  dynamodb_table = "my-app-terraform-locks"
  encrypt        = true
}
```

Each environment gets its own key: `dev/`, `staging/`, `prod/`. Isolated state, shared backend.

**What this gives you:**

✅ State survives hardware failure (S3 durability: 99.999999999%)
✅ Locking prevents concurrent corruption
✅ Versioning enables rollback if state gets corrupted
✅ Encryption protects secrets at rest
✅ Teams can collaborate on the same infrastructure
✅ Cost: effectively $0/month

**Key decisions I made:**

- `prevent_destroy = true` on the bucket — can't accidentally delete your state
- `PAY_PER_REQUEST` billing on DynamoDB — $0 when idle
- Account ID in bucket name — globally unique without guessing
- All four public access block settings — defense in depth

**For aspiring DevOps engineers:**

If you're running Terraform with local state in anything beyond a personal experiment, stop. Set up remote state first. It takes 15 minutes and saves you from disasters that take days to recover from.

The state file is not optional infrastructure. It IS your infrastructure.

---

#Terraform #DevOps #AWS #S3 #InfrastructureAsCode #CloudEngineering #BestPractices


---

## Post 4: Building a Deploy Pipeline That Actually Protects Production

**"It passed staging" isn't a deployment strategy.**

I asked myself: "What stops me from deploying broken code to production at 2am when I'm tired?"

The honest answer: nothing. I had CI running Jest tests and ESLint. I had a staging environment on ECS Fargate. But the path from "code merged" to "running in prod" was just me clicking a button. No verification. No gates. No rollback.

That's not engineering. That's hope.

So I rebuilt the entire delivery pipeline using GitHub Actions, Cypress, and release-please:

**Staging (automatic on merge to main):**
→ Docker build & push to GHCR → Migration pre-check (psql connectivity + dangerous DDL scan) → Deploy to ECS → Integration tests (bash/curl, 30s) → Cypress E2E (Chrome, headless — tests login, CRUD, security headers) → Verified

**Production (manual trigger only):**
→ Verify image exists in GHCR → Confirm staging workflow PASSED via GitHub API → Migration pre-check against prod RDS → Deploy to ECS Fargate → Post-deploy integration tests → Auto-rollback if verification fails

**The thinking behind it:**

- Bash curl tests run first (30 seconds). They catch "app is down, DB disconnected, auth broken." Why burn 3 minutes of Cypress if the health endpoint returns 503?
- Cypress runs second — real Chrome, real user flows. Login, create a member, validate pagination. These catch what curl can't: broken UI state, missing headers, session issues.
- The staging gate is *enforced*. Production deploy queries GitHub's Actions API to verify staging succeeded for this exact commit SHA. Can't bypass without an emergency override that logs who, when, and why.
- release-please handles semantic versioning from conventional commits. Every prod release is a tagged image (v2.1.0, not "latest"). You always know what's running.
- Auto-rollback covers what ECS circuit breakers can't — the "container is healthy but the app is functionally broken" scenario.

Now I merge on Friday and sleep. If something breaks in prod, ECS + my verification pipeline rolls it back in under 2 minutes. No pager. No panic.

**For junior and aspiring DevOps engineers:**

CI protects your codebase. Your deploy pipeline protects your users. They are different concerns that require different tools.

The question isn't "does my code compile?" It's "if I deploy this right now, will users notice?"

Build every pipeline with that question in mind.

---

Stack: GitHub Actions | ECS Fargate | Docker | GHCR | Cypress | Terraform | RDS PostgreSQL | release-please | bash

#DevOps #CICD #GitHubActions #AWS #ECS #Cypress #Deployment #SRE #PipelineEngineering #Terraform


---

## Post 5: The Health Check That Was Always Broken (And Nobody Knew)

**My Docker container was "unhealthy" for weeks. The app worked perfectly. Here's how I found out.**

I added a monitoring stack (Prometheus, Grafana, Loki, Jaeger) to a Node.js app running on Alpine Linux. Configured the monitoring services to depend on the app being healthy.

They refused to start. "dependency failed to start: container is unhealthy."

But the app was clearly running. Logs showed "Server started." I could curl it from my laptop. Health endpoint returned 200. What's going on?

Ran the health check manually inside the container:

```
$ wget http://localhost:3000/health
Connecting to localhost:3000 ([::1]:3000)
Connection refused
```

There it is. `[::1]` — that's IPv6.

**The root cause:**

Alpine Linux resolves `localhost` to `::1` (IPv6 loopback first). My Node.js app was listening on `0.0.0.0:3000` (IPv4 only). The health check was connecting to an address where nothing was listening.

The fix: one character change.

```yaml
# Before (broken on Alpine)
test: ["CMD", "wget", "http://localhost:3000/health"]

# After (works everywhere)
test: ["CMD", "wget", "http://127.0.0.1:3000/health"]
```

**Why nobody noticed before:**

The health check had been failing since day one. But nothing in the docker-compose depended on it. The app ran fine, served traffic fine. Docker quietly marked it "unhealthy" in the background — invisible until another service actually checked.

Adding `depends_on: condition: service_healthy` for the monitoring stack exposed a bug that was always there.

**For junior and aspiring DevOps engineers:**

Three lessons from this one bug:

1. Never use `localhost` in container health checks. Use `127.0.0.1`. Alpine, BusyBox, and minimal images resolve hostnames differently than Ubuntu or macOS.

2. Test your health checks independently. Run them manually inside the container: `docker compose exec app <your-health-check-command>`. Don't assume they work just because the app is running.

3. Silent failures are the most dangerous kind. This health check was broken for weeks. No error in logs. No crash. No alert. Just a quiet "unhealthy" label that nothing was reading — until something was.

The monitoring stack that exposed this bug? OpenTelemetry + Prometheus + Grafana + Loki + Jaeger. All running locally with one command. Now I can see latency percentiles, trace individual requests through Express → PostgreSQL, correlate logs to traces, and get alerted before users notice.

That's the difference between "it works on my machine" and "I know it's working in production."

---

Stack: Docker | Alpine Linux | Node.js | OpenTelemetry | Prometheus | Grafana | Loki | Jaeger

#DevOps #Docker #Troubleshooting #Observability #Monitoring #AlpineLinux #SRE #ContainerHealth #Prometheus #Grafana


---

## Post 6: Your App Can Handle 1 User. Can It Handle 150?

**I ran a stress test against my app. At 100 concurrent users, response times went from 50ms to 3 seconds. Here's what I found and how I fixed the deploy pipeline to catch this before users do.**

Most apps work perfectly when one developer curls the API. The question is: what happens under real load?

I set up k6 (Grafana's load testing tool) with four test types:
- **Smoke:** 1 user, 30 seconds. Sanity check after every deploy.
- **Stress:** Ramps to 150 users. Finds the breaking point.
- **Spike:** Jumps from 10 to 200 users instantly. Tests resilience.
- **Soak:** 30 users for 15 minutes. Detects memory leaks.

The stress test revealed my breaking point: at 100 concurrent users, the database connection pool (20 connections) was exhausted. New requests queued up. Latency exploded. The app didn't crash — it just became unusably slow.

**The fix wasn't just tuning the pool.** The fix was making sure bad deploys can't reach all users:

I implemented **canary deployments** using AWS CodeDeploy:
- New version launches alongside the old one
- Only 10% of traffic goes to the new version
- CloudWatch alarms monitor for 5 minutes: error rate, latency, unhealthy targets
- If ANY alarm fires → instant rollback. 90% of users never noticed.
- If clean → remaining traffic shifts. Old version terminates after a 10-minute buffer.

The combination: load test in staging to find limits, canary deploy in production to limit blast radius. Even if something slips through staging, the canary catches it with minimal user impact.

**For junior and aspiring DevOps/SRE engineers:**

Three things that separate senior from junior:

1. **Prove your assumptions.** "It should handle the load" is a guess. `k6 run stress.js` is evidence. Run it before every release.

2. **Limit blast radius.** Rolling updates affect all users immediately. Canary deployments let you test in production with 10% exposure. If your monitoring is good, you catch issues in minutes, not hours.

3. **Make rollback instant.** Keep the old version running during the canary window. If something goes wrong, traffic reroutes in seconds — no rebuild, no redeploy, no downtime.

Production confidence isn't about preventing all bugs. It's about detecting them fast and limiting who they affect.

---

Stack: k6 | AWS CodeDeploy | ECS Fargate | CloudWatch Alarms | Terraform | GitHub Actions | Prometheus | Grafana

#DevOps #SRE #LoadTesting #CanaryDeployment #AWS #CodeDeploy #k6 #Reliability #BlueGreen #PipelineEngineering


---

## Post 7: My Load Test Failed. My Security Worked.

**Ran a smoke test against my app. Login failed 100% of the time. The app was perfectly healthy.**

I set up k6 to run a basic smoke test — 1 virtual user, 30 seconds, hits health check then logs in. Health passed. Database connected. But every single login attempt returned an error.

The response: `"Too many login attempts. Please try again in 15 minutes."`

My rate limiter was doing exactly what it's supposed to do. I had it set to 10 login attempts per 15-minute window. The smoke test runs in a loop — it blew past 10 attempts in under 15 seconds. After that, every login got blocked.

**Rate limiting and load testing are natural enemies.**

Your security controls protect users from brute force attacks. Your load tests simulate traffic that LOOKS like a brute force attack. Same pattern, different intent.

**How real teams solve this:**

1. Make rate limits configurable via environment variables. Production stays strict (10/15min). Local dev and staging use a higher ceiling for testing.

```javascript
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX) || 10,
});
```

2. Your `.env` for load testing sets `RATE_LIMIT_LOGIN_MAX=10000`. Production never sets this variable, so it defaults to 10.

3. Never disable rate limiting entirely — even in staging. Just raise the threshold high enough that your load test VUs won't hit it during normal scenarios.

**The lesson for junior DevOps engineers:**

When a load test fails, ask two questions before debugging the app:

1. Is the failure a security control doing its job? (Rate limiting, WAF rules, CORS)
2. Is the failure a test environment configuration issue? (Missing seed data, wrong env vars, stale containers)

Most "broken" load tests aren't app bugs. They're test environment gaps. The fix is environment configuration, not code changes.

Your security should work against attackers AND against your own tests. The difference is: you configure your test environment to account for it. Attackers can't.

---

#DevOps #LoadTesting #RateLimiting #k6 #Security #SRE #Testing #NodeJS #ExpressJS
