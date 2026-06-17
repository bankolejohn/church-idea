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
