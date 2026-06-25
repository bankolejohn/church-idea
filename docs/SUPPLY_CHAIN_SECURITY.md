# Supply Chain Security — Deep Dive

This document explains everything about the supply chain security measures added to the Church CMS project. Written for learning.

---

## Table of Contents

1. [What is Supply Chain Security?](#what-is-supply-chain-security)
2. [Why It Matters (Real-World Attacks)](#why-it-matters-real-world-attacks)
3. [The Four Measures We Implemented](#the-four-measures-we-implemented)
4. [Trivy IaC Scanning (Infrastructure Security)](#trivy-iac-scanning-infrastructure-security)
5. [Cosign Image Signing (Provenance & Integrity)](#cosign-image-signing-provenance--integrity)
6. [SBOM Generation (Transparency)](#sbom-generation-transparency)
7. [Dockerfile Hardening (Attack Surface Reduction)](#dockerfile-hardening-attack-surface-reduction)
8. [How It All Connects in the Pipeline](#how-it-all-connects-in-the-pipeline)
9. [Files Created and Modified](#files-created-and-modified)
10. [Key Concepts for Interviews](#key-concepts-for-interviews)

---

## What is Supply Chain Security?

Your application doesn't just consist of YOUR code. It includes:
- 766 npm packages (and their transitive dependencies)
- A base Docker image (node:20-alpine — with its own packages)
- Terraform modules (infrastructure definitions)
- CI/CD pipelines (GitHub Actions workflows)
- Container registries (where images are stored and pulled from)

**Supply chain security** means securing EVERY LINK in this chain — not just your code, but everything it depends on and everything that touches it between source code and production.

Think of it like food safety. You don't just check the restaurant kitchen. You check the farm, the truck, the warehouse, and the delivery driver. If ANY link is compromised, the end product is compromised.

---

## Why It Matters (Real-World Attacks)

| Attack | Year | What Happened | Impact |
|--------|------|---------------|--------|
| **SolarWinds** | 2020 | Attackers injected malware into the build pipeline. Signed updates delivered malware to 18,000 organizations. | US government agencies, Fortune 500 companies compromised |
| **Codecov** | 2021 | CI/CD tool's bash uploader script was modified. Harvested environment variables (secrets, tokens) from thousands of CI pipelines. | Secrets exfiltrated from Twitch, HashiCorp, others |
| **ua-parser-js** | 2021 | Popular npm package (8M weekly downloads) hijacked. Crypto miner + password stealer added. | Millions of applications potentially affected |
| **log4j** | 2021 | Critical RCE vulnerability in a Java logging library. Most organizations didn't know they were using it (transitive dependency). | Every Java application in the world potentially affected |
| **xz-utils** | 2024 | Backdoor inserted into a compression library over 2 years of "legitimate" contributions. Targeted SSH authentication. | Nearly compromised every Linux distribution |

**The common theme:** The attack isn't on YOUR code. It's on something you DEPEND on.

---

## The Four Measures We Implemented

| Measure | What It Does | Threat It Addresses |
|---------|-------------|---------------------|
| **Trivy IaC Scanning** | Finds security misconfigurations in Terraform | "Oops, I left the S3 bucket public" |
| **Cosign Image Signing** | Cryptographically proves WHO built the image | "Someone pushed a tampered image to our registry" |
| **SBOM Generation** | Lists every dependency in the image | "Do we use that vulnerable library?" |
| **Dockerfile Hardening** | Minimizes what's in the container | "The attacker got shell access but can't do anything" |

---

## Trivy IaC Scanning (Infrastructure Security)

### What It Does

Scans your Terraform files and checks them against hundreds of security rules. Catches mistakes like:

- S3 bucket without encryption
- Security group open to 0.0.0.0/0 on all ports
- RDS instance publicly accessible
- IAM policy with `*` permissions
- CloudWatch logging disabled
- No backup retention configured

### How It Works

```yaml
# In .github/workflows/security-supply-chain.yml
- name: Run Trivy IaC scan on Terraform
  uses: aquasecurity/trivy-action@master
  with:
    scan-type: 'config'          # IaC scanning mode
    scan-ref: 'infrastructure/terraform'  # What to scan
    severity: 'CRITICAL,HIGH,MEDIUM'
    format: 'table'              # Human-readable output
```

### What It Checks (Examples)

| Rule | What It Catches | Severity |
|------|----------------|----------|
| AVD-AWS-0086 | S3 bucket without server-side encryption | HIGH |
| AVD-AWS-0107 | Security group with unrestricted ingress | CRITICAL |
| AVD-AWS-0077 | RDS instance publicly accessible | HIGH |
| AVD-AWS-0057 | IAM policy allows `*` actions | CRITICAL |
| AVD-AWS-0104 | ALB not dropping invalid HTTP headers | MEDIUM |
| AVD-AWS-0017 | CloudTrail not enabled | HIGH |

### Why Scan on Every PR

Infrastructure misconfigurations are the #1 cause of cloud breaches. A developer adds a security group rule for debugging, forgets to remove it — now the database is exposed to the internet. IaC scanning catches this BEFORE it reaches production.

### The .trivyignore File

Sometimes Trivy reports findings that aren't applicable or are accepted risks:

```
# .trivyignore
# CVE-2024-XXXXX  # Not applicable: affects Windows only
```

Every suppressed finding MUST have a comment explaining WHY. This is auditable — a security reviewer can see what was accepted and whether the justification still holds.

---

## Cosign Image Signing (Provenance & Integrity)

### The Problem

You build an image in CI and push it to GHCR. Later, your deploy workflow pulls that image and runs it in production. But how do you know the image wasn't tampered with between build and deploy?

Scenarios:
- Attacker gains access to your registry and pushes a modified image with the same tag
- Supply chain compromise: a malicious layer is injected during build
- Internal threat: someone pushes an unauthorized image bypassing CI

### How Cosign Solves This

Cosign is a container signing tool from Sigstore (Linux Foundation project).

**Keyless signing** (what we use):
1. GitHub Actions requests an identity token from GitHub's OIDC provider
2. Sigstore's Fulcio CA verifies the identity (proves it's YOUR GitHub Actions workflow)
3. Signs the image digest with a short-lived certificate
4. Signature is stored in Rekor (public transparency log)

**No private key to manage.** The identity IS the proof. "This image was built by github.com/bankolejohn/church-idea's CI workflow."

### The Signing Flow

```
Build image
     │
     ▼
Push to GHCR (get digest: sha256:abc123...)
     │
     ▼
cosign sign --yes ghcr.io/bankolejohn/church-idea@sha256:abc123...
     │
     ├── GitHub OIDC token proves identity
     ├── Fulcio issues short-lived certificate
     ├── Image digest is signed
     └── Signature stored in Rekor transparency log
     │
     ▼
Before deploy:
cosign verify --certificate-identity-regexp="https://github.com/bankolejohn/church-idea.*" \
              --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
              ghcr.io/bankolejohn/church-idea@sha256:abc123...
     │
     ├── Checks signature exists in Rekor
     ├── Verifies certificate was issued to YOUR workflow
     └── Confirms digest hasn't changed
```

### What This Means in Practice

If ANYONE (including an attacker who compromises your registry) pushes a different image with the same tag, the signature verification will FAIL because:
- The digest won't match the signed digest
- The certificate won't match your GitHub identity
- The transparency log won't have a record of that build

### Why "Keyless" Matters

Traditional signing (GPG, notary) requires managing private keys. If the key leaks, anyone can sign. If the key is lost, you can't sign. Key rotation is painful.

Keyless signing eliminates this:
- No secrets to manage or rotate
- Identity-based (tied to your CI/CD identity, not a file)
- Short-lived certificates (compromise window is seconds, not months)
- Publicly auditable (Rekor transparency log)

---

## SBOM Generation (Transparency)

### What is an SBOM?

**Software Bill of Materials** — a complete inventory of everything in your container image. Every package, every library, every version.

Think of it like a food ingredients label. You look at the box and know EXACTLY what's inside.

### Why SBOMs Exist

**The log4j problem:** In December 2021, a critical vulnerability was found in log4j. The first question every company asked: "Do we use log4j?" Most couldn't answer quickly because:
- It's a transitive dependency (your code → Spring → log4j)
- It's buried inside container images
- Nobody tracks what's actually deployed

With an SBOM, the answer is instant: search the SBOM for `log4j`. Found? You're affected. Not found? You're safe. No guessing.

### Two SBOM Formats

| Format | Standard | Created By | Best For |
|--------|----------|-----------|----------|
| **SPDX** | ISO/IEC 5962:2021 | Linux Foundation | Compliance, legal (licenses) |
| **CycloneDX** | OWASP standard | OWASP | Security, vulnerability tracking |

We generate BOTH because different tools and auditors expect different formats.

### How Syft Generates the SBOM

```yaml
- name: Generate SBOM (SPDX format)
  uses: anchore/sbom-action@v0
  with:
    image: ghcr.io/bankolejohn/church-idea@sha256:abc123...
    format: spdx-json
    output-file: sbom-spdx.json
```

Syft (by Anchore) inspects the container image layer by layer:
1. Reads the Alpine package database (`/lib/apk/db/installed`)
2. Reads `node_modules/` and `package-lock.json`
3. Identifies system libraries, their versions, and licenses
4. Outputs a structured JSON document listing everything

### Attaching SBOM to the Image

```yaml
cosign attest --yes \
  --predicate sbom-spdx.json \
  --type spdxjson \
  ghcr.io/bankolejohn/church-idea@sha256:abc123...
```

This attaches the SBOM directly to the image in the registry. Anyone pulling the image can also pull its SBOM. This is the "nutrition label on the package" model.

### Scanning the SBOM for Vulnerabilities

After generating the SBOM, we scan it with Trivy:

```yaml
- name: Scan SBOM with Trivy
  uses: aquasecurity/trivy-action@master
  with:
    scan-type: 'sbom'
    scan-ref: 'sbom-cyclonedx.json'
    severity: 'CRITICAL,HIGH'
```

This is faster than scanning the full image because the SBOM is already extracted — Trivy just matches package versions against its vulnerability database.

### US Executive Order 14028

In May 2021, the US government mandated that all software sold to federal agencies must include an SBOM. This is spreading to the private sector. Companies like Google, Microsoft, and AWS now require SBOMs from their vendors.

If you work at a company that sells to the government or enterprise, SBOM generation isn't optional — it's a compliance requirement.

---

## Dockerfile Hardening (Attack Surface Reduction)

### The Principle: Minimal Attack Surface

If an attacker gets into your container, what can they do? The answer depends on what's IN the container:

| Has Shell? | Has Package Manager? | Has Network Tools? | Risk Level |
|-----------|---------------------|-------------------|------------|
| Yes | Yes | Yes | HIGH — attacker can download tools, install backdoors |
| Yes | No | No | MEDIUM — limited but can still execute scripts |
| No | No | No | LOW — can only run your app binary, nothing else |

### What We Hardened

**1. Non-root user with explicit UIDs:**
```dockerfile
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup
USER 1001:1001
```

Why explicit IDs (not just names)?
- Reproducible across rebuilds
- Kubernetes security contexts can match on UID
- Audit logs show consistent user IDs

**2. Restrictive file permissions:**
```dockerfile
RUN chown -R appuser:appgroup /app && \
    chmod -R 555 /app && \
    chmod -R 755 /app/node_modules
```

- `555` = read + execute, no write. App code can't be modified at runtime.
- `755` for node_modules = readable, needed for `require()` to work.
- An attacker can't modify your application files even if they get shell access.

**3. Minimal COPY (explicit files only):**
```dockerfile
COPY server.js ./
COPY lib/ ./lib/
COPY db/ ./db/
COPY public/ ./public/
COPY package.json ./
```

We NEVER use `COPY . .` because that would include:
- `.env` files (secrets!)
- `.git` directory (history, possibly older secrets)
- `node_modules` from local dev (might have different versions)
- Test files, docs, coverage reports (unnecessary bulk)

**4. OCI Labels (metadata):**
```dockerfile
LABEL org.opencontainers.image.source="https://github.com/bankolejohn/church-idea"
LABEL org.opencontainers.image.description="Church CMS - Production"
```

These help scanners, registries, and humans identify what the image is, where it came from, and its license. GitHub uses these to link container packages to repositories.

**5. Exec form CMD:**
```dockerfile
CMD ["node", "server.js"]
```

Not `CMD node server.js` (shell form). Exec form:
- Runs node as PID 1 (receives SIGTERM directly for graceful shutdown)
- No shell wrapper that could be exploited
- Proper signal handling for Docker stop/Kubernetes termination

### The Distroless Upgrade Path

When ready for maximum security:

```dockerfile
FROM gcr.io/distroless/nodejs20-debian12
COPY --from=deps /app/node_modules ./node_modules
COPY server.js ./
CMD ["server.js"]
```

What distroless removes:
- Shell (`/bin/sh`) — no exec into container
- Package manager (`apk`, `apt`) — can't install anything
- Utilities (`wget`, `curl`, `ls`, `cat`) — can't explore filesystem
- Users other than `nonroot` and `root`

Trade-off: can't use `wget` in health checks. Must use a Node.js-based health check or TCP check instead.

---

## How It All Connects in the Pipeline

```
Developer pushes code
        │
        ▼
┌─── security-supply-chain.yml ─────────────────────────────────────┐
│                                                                     │
│  ┌──────────────────┐                                              │
│  │ 1. Trivy IaC     │  "Is the infrastructure secure?"            │
│  │    Scan Terraform │  Checks 100+ security rules                 │
│  │    → SARIF report │  Results in GitHub Security tab             │
│  └──────────────────┘                                              │
│                                                                     │
│  ┌──────────────────┐                                              │
│  │ 2. Build Image   │  Standard Docker build                      │
│  │    Push to GHCR  │  Tagged with SHA                             │
│  └────────┬─────────┘                                              │
│           │                                                         │
│           ▼                                                         │
│  ┌──────────────────┐                                              │
│  │ 3. Cosign Sign   │  "This image was built by MY pipeline"      │
│  │    Keyless (OIDC)│  Signature stored in Rekor transparency log  │
│  └────────┬─────────┘                                              │
│           │                                                         │
│           ▼                                                         │
│  ┌──────────────────┐                                              │
│  │ 4. Syft SBOM     │  "What's inside this image?"                │
│  │    SPDX + CDX    │  Full dependency inventory                   │
│  │    Attach to img │  Stored alongside image in registry          │
│  └────────┬─────────┘                                              │
│           │                                                         │
│           ▼                                                         │
│  ┌──────────────────┐                                              │
│  │ 5. Trivy SBOM    │  "Are any dependencies vulnerable?"         │
│  │    Vuln Scan     │  Scans SBOM against CVE database            │
│  │    → SARIF report│  Results in GitHub Security tab              │
│  └──────────────────┘                                              │
└─────────────────────────────────────────────────────────────────────┘
        │
        ▼
Deploy to production (deploy-prod.yml)
        │
        ▼
┌──────────────────────┐
│ Cosign VERIFY        │  "Was this image built by our pipeline?"
│ Before deploying     │  Rejects tampered/unauthorized images
└──────────────────────┘
```

---

## Files Created and Modified

```
.github/workflows/
└── security-supply-chain.yml  ← NEW: Trivy IaC + Cosign + SBOM pipeline
└── deploy-prod.yml            ← MODIFIED: Added Cosign verify before deploy

Dockerfile                      ← REWRITTEN: Hardened (explicit UIDs, 555 perms, OCI labels)
.trivyignore                    ← NEW: Accepted risk documentation
```

### Dockerfile Changes (Before → After)

| Aspect | Before | After |
|--------|--------|-------|
| User | `adduser -S appuser` (random UID) | `adduser -u 1001 -S appuser` (explicit UID) |
| Permissions | `chown -R appuser:appgroup /app` | `chmod -R 555 /app` (read-only app code) |
| Labels | None | Full OCI labels (source, description, license) |
| wget | Not explicitly installed | Explicitly installed (for health check) |
| System cleanup | None | `rm -rf /var/cache/apk/* /tmp/*` |
| CMD | `CMD ["node", "server.js"]` | Same (already correct) |

---

## Key Concepts for Interviews

**Q: "What is supply chain security and why does it matter?"**
A: It's securing everything between source code and production — dependencies, build tools, registries, infrastructure definitions. It matters because modern applications are 80%+ third-party code. Attacks like SolarWinds and log4j showed that compromising one dependency can affect thousands of organizations.

**Q: "How does Cosign keyless signing work?"**
A: Instead of managing private keys, it uses your CI/CD platform's identity. GitHub Actions gets a short-lived OIDC token that proves "I am this workflow in this repository." Sigstore's Fulcio CA verifies that identity and issues a short-lived certificate to sign the image. The signature is recorded in Rekor (a public transparency log). Verification checks: does the signature match the image digest? Was the certificate issued to the expected identity?

**Q: "What's the difference between an image scan and an SBOM scan?"**
A: An image scan (Trivy on image) analyzes the container filesystem directly — slow, requires pulling the full image. An SBOM scan analyzes the pre-extracted inventory (JSON file) — fast, can be done without the image. SBOM also enables historical analysis: "were we affected by CVE-X last month?" by scanning old SBOMs.

**Q: "Why run as non-root in containers?"**
A: If an attacker exploits a vulnerability in your app and gets code execution, they inherit the process's user permissions. As root, they can: install tools, modify system files, access other containers' data (in some configurations), escape to the host (certain kernel vulns). As UID 1001 with read-only filesystem, they can't modify anything or install anything.

**Q: "What's the difference between SPDX and CycloneDX?"**
A: Both are SBOM formats. SPDX is an ISO standard focused on licensing and legal compliance — "do we have permission to use all these packages?" CycloneDX is an OWASP standard focused on security — "are any of these packages vulnerable?" We generate both because different stakeholders (legal vs security) use different tools.

**Q: "What does Trivy IaC scanning catch that code review misses?"**
A: Humans reviewing Terraform PRs focus on "does this do what we want?" Trivy checks 500+ rules like: "Is this S3 bucket encrypted? Is this security group too permissive? Is deletion protection enabled? Is logging configured?" These are easy to miss in code review because they're often not the focus of the change.

**Q: "How do you handle false positives from security scanners?"**
A: Document and suppress with justification. We use `.trivyignore` with comments explaining WHY each finding is accepted. This is auditable — a reviewer can see what was suppressed and whether the justification is still valid. Suppressions should be reviewed quarterly.

**Q: "What happens if someone pushes an unsigned image and tries to deploy?"**
A: The `deploy-prod.yml` workflow runs `cosign verify` before deploying. If the image isn't signed by our pipeline's identity, verification fails and the deployment is blocked. Currently it's a warning (for backward compatibility with pre-signing images), but it should be changed to a hard failure once all images are signed.

---

## Running Locally

### Verify a signature manually:
```bash
# Install cosign
brew install cosign

# Verify an image (replace with actual image reference)
cosign verify \
  --certificate-identity-regexp="https://github.com/bankolejohn/church-idea.*" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  ghcr.io/bankolejohn/church-idea:latest
```

### Scan Terraform locally:
```bash
# Install trivy
brew install trivy

# Scan infrastructure
trivy config infrastructure/terraform/

# Scan with specific severity
trivy config --severity CRITICAL,HIGH infrastructure/terraform/
```

### Generate SBOM locally:
```bash
# Install syft
brew install syft

# Generate SBOM from a local image
docker build -t church-cms:local .
syft church-cms:local -o spdx-json > sbom.json

# View human-readable
syft church-cms:local -o table
```

### Inspect SBOM contents:
```bash
# Count dependencies
cat sbom.json | jq '.packages | length'

# List all packages with versions
cat sbom.json | jq '.packages[] | "\(.name) \(.versionInfo)"' | sort

# Find a specific package
cat sbom.json | jq '.packages[] | select(.name | contains("express"))'
```

---

## What's Next

With supply chain security in place:
1. **Enforce signature verification** (change from warning to hard failure in deploy-prod.yml)
2. **Add Kyverno** (when on K8s) to reject unsigned images at admission
3. **SBOM-based vulnerability alerting** (scan old SBOMs when new CVEs are published)
4. **SLSA compliance** (Supply chain Levels for Software Artifacts — provenance attestation)
5. **Private registry** (move from GHCR to ECR with image scanning on push)
