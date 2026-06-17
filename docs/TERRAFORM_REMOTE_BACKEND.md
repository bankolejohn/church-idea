# Terraform Remote Backend: S3 + DynamoDB

A complete walkthrough of how and why we set up remote state management for our infrastructure.

---

## The Problem

When you run `terraform apply`, Terraform creates a **state file** (`terraform.tfstate`). This file is a JSON record of every resource Terraform manages — IDs, ARNs, configurations, everything.

By default, this state file lives on your local machine. That's dangerous:

| Scenario | What Happens |
|----------|-------------|
| Your laptop dies | You lose track of what's deployed. Terraform can't manage the resources anymore. |
| Two people run `apply` simultaneously | State becomes corrupted. Resources get duplicated or orphaned. |
| State file gets deleted accidentally | Terraform thinks nothing exists and tries to recreate everything. |
| Someone commits state to git | Secrets are exposed (state contains database passwords, ARNs, etc.) |

**Remote state solves all of these.**

---

## The Solution: S3 + DynamoDB

| Component | Purpose |
|-----------|---------|
| **S3 Bucket** | Stores the state file (durable, encrypted, versioned) |
| **DynamoDB Table** | Provides a lock (prevents concurrent access) |

```
Developer A runs terraform apply
     │
     ▼
┌─────────────┐     ┌──────────────────┐
│  DynamoDB   │◄────│ Acquire Lock     │
│  Lock Table │     │ (LockID = env)   │
└─────────────┘     └──────────────────┘
     │                        │
     │ Lock acquired          │ If lock held by someone else → BLOCKED
     ▼                        ▼
┌─────────────┐     ┌──────────────────┐
│  S3 Bucket  │◄────│ Read State       │
│  (state)    │     │ Apply Changes    │
│             │────►│ Write New State  │
└─────────────┘     └──────────────────┘
     │
     ▼
┌─────────────┐
│  DynamoDB   │◄──── Release Lock
│  Lock Table │
└─────────────┘
```

---

## The Chicken-and-Egg Problem

To store Terraform state in S3, you need an S3 bucket. But to create an S3 bucket with Terraform, you need somewhere to store the state. This is the bootstrap problem.

**The solution:** Create the backend infrastructure with **local state** first (just once), then configure all other environments to use it.

```
Step 1: Create backend (S3 + DynamoDB) → state stored locally (one-time)
Step 2: Configure environments to use S3 → state stored remotely (forever)
```

The backend module's local state is small and stable — it only tracks the bucket and table. You almost never need to touch it again.

---

## Step-by-Step Implementation

### Step 1: Create the Backend Module

File: `infrastructure/terraform/backend/main.tf`

```hcl
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # NOTE: No backend block here. This module uses LOCAL state intentionally.
}

provider "aws" {
  region = "us-east-1"
}
```

**Why no backend block?** This IS the backend. It can't store its own state in itself (that's the chicken-and-egg). It uses local state.

### Step 2: Create the S3 Bucket

```hcl
resource "aws_s3_bucket" "terraform_state" {
  bucket = "church-cms-terraform-state-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}
```

**Why include account ID in the name?** S3 bucket names are globally unique across all AWS accounts. Adding the account ID prevents conflicts.

**Why `prevent_destroy = true`?** Accidentally destroying the state bucket would orphan ALL your infrastructure. This makes `terraform destroy` refuse to delete it.

### Step 3: Enable Versioning

```hcl
resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}
```

**Why versioning?** If a `terraform apply` corrupts the state, you can roll back to a previous version. Without this, corrupted state = manual recovery nightmare.

### Step 4: Encrypt at Rest

```hcl
resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
```

**Why encryption?** State files contain sensitive data: database passwords, secret ARNs, private IPs. Even though S3 access is restricted, encryption adds defense in depth.

### Step 5: Block Public Access

```hcl
resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

**Why all four settings?** Belt and suspenders. Even if someone accidentally adds a public ACL or policy, these settings override and deny. State files should NEVER be public.

### Step 6: Create the DynamoDB Lock Table

```hcl
resource "aws_dynamodb_table" "terraform_locks" {
  name         = "church-cms-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
```

**Why DynamoDB?** It provides atomic conditional writes — perfect for distributed locking. When Terraform acquires a lock, it writes a record. If the record already exists, the lock is held and the second caller is blocked.

**Why `PAY_PER_REQUEST`?** You only pay when Terraform runs (a few times per day at most). With provisioned capacity, you'd pay 24/7 for a table that's used 0.01% of the time.

**Why `LockID` as the hash key?** This is what Terraform expects. The key is set to `<bucket>/<state-key>` — meaning each environment gets its own lock.

### Step 7: Deploy the Backend

```bash
cd infrastructure/terraform/backend
terraform init
terraform apply
```

This creates the S3 bucket and DynamoDB table. Done once, never again.

### Step 8: Configure Environments to Use Remote State

In each environment's `main.tf`:

```hcl
terraform {
  backend "s3" {
    bucket         = "church-cms-terraform-state-547624429131"
    key            = "dev/terraform.tfstate"       # Unique per environment
    region         = "us-east-1"
    dynamodb_table = "church-cms-terraform-locks"
    encrypt        = true
  }
}
```

**Why a different `key` per environment?** Each environment needs its own state file. `dev/terraform.tfstate` and `prod/terraform.tfstate` are isolated — destroying dev doesn't affect prod's state.

### Step 9: Migrate Existing Local State to S3

If you already had local state from a previous `terraform apply`:

```bash
terraform init -migrate-state
```

Terraform asks: "Do you want to copy the existing state to the new backend?" → Yes. This uploads your local state to S3 and removes the local file.

---

## Directory Structure

```
infrastructure/terraform/
├── backend/                    # Creates the S3 bucket + DynamoDB (local state)
│   ├── main.tf
│   └── terraform.tfstate       # LOCAL state (only for this module)
│
├── environments/
│   ├── dev/                    # Uses S3 backend → key: "dev/terraform.tfstate"
│   ├── staging/                # Uses S3 backend → key: "staging/terraform.tfstate"
│   └── prod/                   # Uses S3 backend → key: "prod/terraform.tfstate"
```

---

## What This Gives You

| Without Remote Backend | With Remote Backend |
|----------------------|-------------------|
| State on laptop (fragile) | State in S3 (durable, versioned) |
| No locking (corruption risk) | DynamoDB lock (concurrent safety) |
| Can't collaborate | Team shares same state |
| No audit trail | S3 versioning = full history |
| Secrets in local file | Encrypted at rest + access controlled |
| `git add .` could leak state | State never in git |

---

## Common Operations

### Check who holds the lock (if stuck)

```bash
aws dynamodb scan --table-name church-cms-terraform-locks
```

### Force-unlock (if someone's apply crashed)

```bash
terraform force-unlock <LOCK_ID>
```

### View state file versions (recovery)

```bash
aws s3api list-object-versions \
  --bucket church-cms-terraform-state-547624429131 \
  --prefix dev/terraform.tfstate
```

### Roll back to a previous state version

```bash
aws s3api get-object \
  --bucket church-cms-terraform-state-547624429131 \
  --key dev/terraform.tfstate \
  --version-id <VERSION_ID> \
  terraform.tfstate.recovered
```

---

## Cost

- **S3**: ~$0.01/month (state files are a few KB)
- **DynamoDB (pay-per-request)**: ~$0.00/month (a few writes per day)
- **Total**: Effectively free

---

## Security Considerations

1. **IAM Access**: Only users/roles with `s3:GetObject`, `s3:PutObject`, and `dynamodb:PutItem` on these specific resources should be able to run Terraform
2. **Never commit state**: `.gitignore` excludes `*.tfstate*`
3. **Bucket policy**: Can add IP restrictions or MFA delete for production
4. **Enable CloudTrail**: Audit who accessed or modified state files

---

## Summary

Remote state with S3 + DynamoDB is the industry standard for Terraform in production. It provides:

- **Durability** — state survives hardware failure
- **Locking** — prevents corruption from concurrent access
- **Encryption** — protects secrets at rest
- **Versioning** — enables recovery from mistakes
- **Collaboration** — teams share the same source of truth
- **Cost** — effectively $0/month

Every serious Terraform deployment uses this pattern. Local state is only acceptable for learning or throwaway experiments.
