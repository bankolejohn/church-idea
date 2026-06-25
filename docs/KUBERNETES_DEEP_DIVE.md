# Kubernetes Migration — Deep Dive

This document explains everything about the Kubernetes (EKS) infrastructure added to the Church CMS project. Written for learning.

---

## Table of Contents

1. [Why Kubernetes](#why-kubernetes)
2. [EKS vs Self-Managed vs ECS — The Decision](#eks-vs-self-managed-vs-ecs--the-decision)
3. [Architecture Overview](#architecture-overview)
4. [The EKS Terraform Module](#the-eks-terraform-module)
5. [Kubernetes Manifests (Kustomize)](#kubernetes-manifests-kustomize)
6. [Helm Chart](#helm-chart)
7. [ArgoCD GitOps](#argocd-gitops)
8. [Karpenter Node Autoscaling](#karpenter-node-autoscaling)
9. [How Deployment Works (End to End)](#how-deployment-works-end-to-end)
10. [Key Kubernetes Concepts Explained](#key-kubernetes-concepts-explained)
11. [Files Created](#files-created)
12. [Key Concepts for Interviews](#key-concepts-for-interviews)

---

## Why Kubernetes

**ECS is great for:**
- Small teams, single applications, AWS-only shops
- Simple container orchestration without Kubernetes complexity
- Cost-effective at small scale (no control plane cost)

**Kubernetes is needed when:**
- You run 10+ microservices (K8s ecosystem handles service mesh, discovery, etc.)
- You need multi-cloud or hybrid deployment (K8s runs anywhere)
- You want the largest ecosystem of tools (Helm, ArgoCD, Istio, Karpenter, etc.)
- Your team is growing and needs self-service platform capabilities
- Job market: 90%+ of senior DevOps roles require Kubernetes experience

**Why we have BOTH in this project:**
This is a learning project. Having ECS AND EKS shows:
- You understand both and can choose appropriately
- You can migrate workloads between platforms
- You know the trade-offs (not just "K8s good, ECS bad")

---

## EKS vs Self-Managed vs ECS — The Decision

| Factor | ECS Fargate | EKS (managed) | Self-managed K8s |
|--------|-------------|----------------|------------------|
| Control plane | AWS manages | AWS manages | YOU manage |
| Worker nodes | Serverless (no nodes) | Managed node groups | YOU manage |
| Cost (small) | $0 + pay per task | ~$75/month (control plane) | EC2 + your time |
| Cost (large) | Expensive at scale | Cost-effective | Cheapest (if you're good) |
| Ecosystem | Limited (AWS only) | Massive (CNCF) | Massive |
| Learning curve | Low | Medium-High | Very High |
| Hiring pool | Smaller | Largest | Largest |
| Multi-cloud | No | Yes (with work) | Yes |

**Our choice for production:** ECS (simpler, cheaper at this scale)
**Our choice for learning/portfolio:** EKS (industry standard, more tools, bigger ecosystem)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         AWS (us-east-1)                           │
│                                                                   │
│  ┌──────────────── VPC (10.3.0.0/16) ─────────────────────────┐ │
│  │                                                              │ │
│  │  ┌─── Public Subnets ───┐    ┌─── Private Subnets ──────┐  │ │
│  │  │                      │    │                           │  │ │
│  │  │  NAT Gateway         │    │  EKS Control Plane (ENIs) │  │ │
│  │  │  ALB (via Ingress)   │    │  Worker Nodes             │  │ │
│  │  │                      │    │    ├── App Pods            │  │ │
│  │  └──────────────────────┘    │    ├── ArgoCD             │  │ │
│  │                               │    ├── Karpenter          │  │ │
│  │                               │    └── Monitoring          │  │ │
│  │                               │                           │  │ │
│  │                               │  RDS PostgreSQL           │  │ │
│  │                               └───────────────────────────┘  │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ GitOps Flow:                                                │  │
│  │ Git → ArgoCD → Kubernetes API → Pods deployed              │  │
│  │                                                             │  │
│  │ Scaling Flow:                                               │  │
│  │ Pending pods → Karpenter → Launches EC2 → Pod scheduled    │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## The EKS Terraform Module

### What It Creates

| Resource | Purpose |
|----------|---------|
| `aws_eks_cluster` | The Kubernetes control plane (API server, etcd, scheduler) |
| `aws_iam_role` (cluster) | Permissions for EKS to manage AWS resources |
| `aws_iam_openid_connect_provider` | OIDC for IRSA (pods assume IAM roles) |
| `aws_eks_node_group` | Managed EC2 instances running kubelet |
| `aws_iam_role` (nodes) | Permissions for worker nodes (pull images, join cluster) |
| `aws_security_group` | Network rules for control plane communication |
| `aws_eks_addon` (coredns, kube-proxy, vpc-cni) | Core cluster components |
| Karpenter IAM roles + instance profile | Permissions for intelligent autoscaling |

### IRSA (IAM Roles for Service Accounts)

The most important EKS concept for security:

```
Traditional: Pod → uses node's IAM role (ALL pods share the same permissions)
IRSA:        Pod → uses its OWN IAM role (least-privilege per workload)
```

How it works:
1. EKS exposes an OIDC issuer (identity provider)
2. You create an IAM role that trusts that OIDC provider
3. You annotate the Kubernetes ServiceAccount with the role ARN
4. When the pod starts, kubelet injects a JWT token
5. AWS SDKs exchange the token for temporary credentials
6. Pod has ONLY the permissions of its specific role

This means your app pod can access Secrets Manager but NOT S3 backups. The monitoring pod can write to CloudWatch but NOT access the database. Least privilege per workload.

---

## Kubernetes Manifests (Kustomize)

### Why Kustomize

You have the SAME application running in dev, staging, and prod. The differences are:
- Number of replicas (1 vs 2 vs 3)
- Resource limits (small vs large)
- Domain name (dev.x.com vs x.com)
- Log level (debug vs info)

**Without Kustomize:** You'd copy-paste manifests for each environment. Changes require editing 3 files.

**With Kustomize:** One base, patches per environment. Changes to the base automatically propagate.

### Base Manifests (kubernetes/base/)

| File | What It Is |
|------|-----------|
| `deployment.yaml` | Pod template, replicas, probes, resources, security context |
| `service.yaml` | Stable network endpoint for the pods (ClusterIP) |
| `ingress.yaml` | External HTTP/HTTPS access via ALB |
| `hpa.yaml` | Auto-scale pods based on CPU/memory |
| `configmap.yaml` | Non-secret environment variables |
| `serviceaccount.yaml` | Pod identity (for IRSA) |
| `networkpolicy.yaml` | Zero-trust: deny-all, allow only what's needed |
| `pdb.yaml` | "Always keep at least 1 pod running during maintenance" |

### Overlay Structure

```
kubernetes/
├── base/           ← The "template" (shared by all environments)
└── overlays/
    ├── dev/        ← 1 replica, debug logging, 64Mi memory
    ├── staging/    ← 2 replicas, info logging, 128Mi memory
    └── prod/       ← 3 replicas, strict limits, PDB=2
```

### Key Security Features in the Deployment

```yaml
securityContext:
  runAsNonRoot: true          # Refuse to start if image runs as root
  runAsUser: 1001             # Explicit UID
  readOnlyRootFilesystem: true  # Can't write to container filesystem
  allowPrivilegeEscalation: false  # Can't become root
  capabilities:
    drop: ["ALL"]             # Remove ALL Linux capabilities
```

This means even if an attacker gets code execution inside the pod:
- They're user 1001 (not root)
- They can't write to disk (read-only filesystem)
- They can't escalate to root
- They have no special Linux capabilities (can't mount, can't raw network, etc.)

---

## Helm Chart

### Why Helm When We Have Kustomize

| Feature | Kustomize | Helm |
|---------|-----------|------|
| Templating | No (patches only) | Yes (Go templates) |
| Conditional logic | Limited | Full (if/else, loops) |
| Dependencies | No | Yes (subchart for PostgreSQL) |
| Versioned packages | No | Yes (Chart.yaml version) |
| Rollback | kubectl | `helm rollback release 1` |
| Release management | No | Yes (tracks installed versions) |

**In practice:** ArgoCD uses Helm to render templates, then applies them like raw manifests. You get the best of both.

### Chart Structure

```
helm/church-cms/
├── Chart.yaml              ← Name, version, description
├── values.yaml             ← Default config (shared)
├── values-dev.yaml         ← Dev overrides
├── values-staging.yaml     ← Staging overrides
├── values-prod.yaml        ← Prod overrides (pinned image version)
└── templates/
    ├── _helpers.tpl        ← Reusable template functions
    ├── deployment.yaml     ← Pod spec with Go templating
    ├── service.yaml        ← Service definition
    ├── ingress.yaml        ← Ingress with conditional TLS
    ├── hpa.yaml            ← HPA (only if autoscaling.enabled)
    ├── pdb.yaml            ← PDB (only if pdb.enabled)
    ├── configmap.yaml      ← Auto-generated from values.config
    └── serviceaccount.yaml ← Optional with IRSA annotations
```

### How to Use

```bash
# Dry-run (see what would be generated)
helm template church-cms ./helm/church-cms -f helm/church-cms/values-staging.yaml

# Install to cluster
helm install church-cms ./helm/church-cms \
  -f helm/church-cms/values-staging.yaml \
  -n church-cms-staging --create-namespace

# Upgrade (deploy new version)
helm upgrade church-cms ./helm/church-cms \
  -f helm/church-cms/values-prod.yaml \
  --set image.tag=2.1.0 \
  -n church-cms-prod

# Rollback to previous version
helm rollback church-cms 1 -n church-cms-prod
```

---

## ArgoCD GitOps

### The Core Principle

**Traditional deployment:** CI builds image → CI runs `kubectl apply` → Cluster updates
**GitOps deployment:** CI builds image → Developer updates Git → ArgoCD syncs cluster

The difference: in GitOps, **Git is the single source of truth**. The CI pipeline never touches the cluster directly. Only ArgoCD does.

### Why This Matters

1. **Audit trail:** Every deployment is a Git commit (who, what, when, why)
2. **Rollback:** `git revert` → ArgoCD syncs → cluster rolls back
3. **Drift detection:** If someone manually `kubectl edit`s a deployment, ArgoCD reverts it
4. **Disaster recovery:** Cluster dies → create new cluster → point ArgoCD at Git → everything rebuilds
5. **Security:** CI/CD doesn't need cluster credentials (only ArgoCD does)

### App-of-Apps Pattern

```
argocd/
├── app-of-apps.yaml        ← Parent app (manages all children)
└── apps/
    ├── church-cms-dev.yaml     ← Dev: auto-sync from develop branch
    ├── church-cms-staging.yaml ← Staging: auto-sync from main branch
    └── church-cms-prod.yaml    ← Prod: MANUAL sync from release tag
```

**How it works:**
1. Apply `app-of-apps.yaml` to the cluster (one-time setup)
2. ArgoCD discovers files in `argocd/apps/`
3. Each file becomes a managed Application
4. Add a new file → new environment deployed automatically

### Per-Environment Strategy

| Environment | Source Branch | Sync | Self-Heal |
|-------------|-------------|------|-----------|
| Dev | `develop` | Automatic | Yes (reverts drift) |
| Staging | `main` | Automatic | Yes |
| Production | `v2.0.0` (tag) | **Manual** | No (allow emergency fixes) |

**Why prod is manual:** Auto-sync in production means any push to main immediately deploys. One bad merge = instant outage with no human gate. Manual sync means someone clicks "Sync" after verifying staging is healthy.

---

## Karpenter Node Autoscaling

### The Problem with Cluster Autoscaler

Traditional Cluster Autoscaler:
1. Pod is pending (no node has capacity)
2. CA checks: "Is there a node group that COULD fit this pod?"
3. Increases ASG desired count
4. ASG launches a new EC2 instance (from a FIXED instance type list)
5. Instance boots, joins cluster (~2-5 minutes)
6. Pod is scheduled

**Problems:**
- Slow (2-5 minutes per scale event)
- Wasteful (fixed instance types — might provision too-large instance)
- Rigid (pre-defined node groups per instance type)

### How Karpenter Solves This

1. Pod is pending
2. Karpenter evaluates: "This pod needs 200m CPU, 256Mi memory, Linux, amd64"
3. Checks current Spot pricing across ALL allowed instance types
4. Launches the CHEAPEST instance that fits (~60 seconds)
5. Pod is scheduled

**Key advantages:**
- **60 seconds** vs 2-5 minutes (provision time)
- **Right-sized:** picks `t3.small` for a small pod, `c5.xlarge` for a compute-heavy pod
- **Spot-aware:** prefers Spot instances (70% cheaper), falls back to On-Demand
- **Consolidation:** merges underutilized nodes (moves pods, terminates empty nodes)

### NodePool Configuration

```yaml
requirements:
  # Allow these instance categories
  - key: karpenter.k8s.aws/instance-category
    operator: In
    values: ["c", "m", "t"]  # Compute, General, Burstable

  # Allow these sizes
  - key: karpenter.k8s.aws/instance-size
    operator: In
    values: ["medium", "large", "xlarge"]

  # Prefer Spot, fallback to On-Demand
  - key: karpenter.sh/capacity-type
    operator: In
    values: ["spot", "on-demand"]
```

More variety = more Spot availability = lower costs. Karpenter automatically selects the cheapest available option at any given moment.

---

## How Deployment Works (End to End)

```
Developer merges PR to main
        │
        ▼
CI Pipeline runs (lint, test, build, push to GHCR)
        │
        ▼
ArgoCD detects main branch changed (polls every 3 min or webhook)
        │
        ▼
ArgoCD renders Helm chart: values.yaml + values-staging.yaml
        │
        ▼
ArgoCD compares rendered manifests vs live cluster state
        │
        ├── If different → "OutOfSync" status
        │   └── Auto-sync enabled → applies changes
        │       └── New Deployment revision → rolling update
        │           └── New pods start → old pods drain
        │
        └── If same → "Synced" ✓ (no action needed)

For Production:
        │
        ▼
Release-please creates tag v2.1.0
        │
        ▼
Update argocd/apps/church-cms-prod.yaml → targetRevision: v2.1.0
        │
        ▼
ArgoCD shows "OutOfSync" in UI
        │
        ▼
Engineer clicks "Sync" (manual approval gate)
        │
        ▼
Production updates to v2.1.0
```

---

## Key Kubernetes Concepts Explained

### Probes (Liveness vs Readiness vs Startup)

| Probe | Question | On Failure |
|-------|----------|-----------|
| **Startup** | "Is the app still booting?" | Keep waiting (don't trigger liveness) |
| **Liveness** | "Is the process alive?" | RESTART the pod |
| **Readiness** | "Can it serve traffic?" | Remove from Service (no traffic, but keep running) |

**Common mistake:** Using liveness probe on the `/ready` endpoint. If the DB is temporarily down, the pod is still alive — it just can't serve requests. You want it REMOVED from traffic (readiness), not KILLED (liveness).

### Resource Requests vs Limits

```yaml
resources:
  requests:          # GUARANTEED minimum
    cpu: 100m        # Scheduler uses this to place pods
    memory: 128Mi    # This much is RESERVED for the pod
  limits:            # MAXIMUM allowed
    cpu: 500m        # Can burst up to this (then throttled)
    memory: 512Mi    # If exceeded → OOM killed
```

**requests** = what the scheduler uses. If a node has 1000m CPU and a pod requests 100m, the node can fit 10 pods.

**limits** = the ceiling. CPU limit = throttling (slow but alive). Memory limit = OOM kill (pod dies).

### Pod Anti-Affinity

```yaml
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchExpressions:
          - key: app
            operator: In
            values: ["church-cms"]
      topologyKey: kubernetes.io/hostname
```

This says: "Try NOT to put two church-cms pods on the same node." If a node dies, you lose at most 1 replica (not all of them).

### Network Policy (Zero Trust)

Default Kubernetes networking: EVERY pod can talk to EVERY other pod. This is dangerous — if one pod is compromised, the attacker can reach everything.

Network policies implement deny-by-default:
- Only the Ingress controller can reach port 3000
- Only Prometheus can reach port 9464
- Only port 5432 (PostgreSQL) egress is allowed
- Only port 53 (DNS) for service discovery
- Everything else: DENIED

---

## Files Created

```
infrastructure/terraform/modules/eks/
├── main.tf            ← EKS cluster, node group, OIDC, add-ons
├── variables.tf       ← Config (version, instance types, scaling)
├── outputs.tf         ← Cluster endpoint, OIDC ARN, etc.
└── karpenter.tf       ← Karpenter controller role, node role, instance profile

infrastructure/terraform/environments/eks/
├── main.tf            ← Wires VPC + EKS + RDS + Secrets together
├── variables.tf       ← Environment-specific vars
└── outputs.tf         ← kubeconfig command, endpoints

kubernetes/
├── base/
│   ├── kustomization.yaml  ← Resource list
│   ├── deployment.yaml     ← Pod spec (probes, security, resources)
│   ├── service.yaml        ← ClusterIP service
│   ├── ingress.yaml        ← ALB ingress with annotations
│   ├── hpa.yaml            ← Horizontal Pod Autoscaler
│   ├── configmap.yaml      ← Non-secret env vars
│   ├── serviceaccount.yaml ← Pod identity (IRSA)
│   ├── networkpolicy.yaml  ← Zero-trust network rules
│   └── pdb.yaml            ← Pod Disruption Budget
├── overlays/
│   ├── dev/kustomization.yaml
│   ├── staging/kustomization.yaml
│   └── prod/kustomization.yaml
└── karpenter/
    └── nodepool.yaml       ← Karpenter provisioner + EC2NodeClass

helm/church-cms/
├── Chart.yaml
├── values.yaml             ← Defaults
├── values-dev.yaml
├── values-staging.yaml
├── values-prod.yaml
└── templates/
    ├── _helpers.tpl
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    ├── hpa.yaml
    ├── pdb.yaml
    ├── configmap.yaml
    └── serviceaccount.yaml

argocd/
├── app-of-apps.yaml        ← Parent app managing all environments
└── apps/
    ├── church-cms-dev.yaml     ← Auto-sync from develop
    ├── church-cms-staging.yaml ← Auto-sync from main
    └── church-cms-prod.yaml    ← Manual sync from release tag
```

---

## Key Concepts for Interviews

**Q: "Why EKS instead of self-managed Kubernetes?"**
A: Trade money for operational burden. EKS control plane is managed (HA, patched, upgraded by AWS). Self-managed means YOU handle etcd backups, API server availability, certificate rotation, and version upgrades. For most teams, the $75/month is worth not paging at 3am for a control plane issue.

**Q: "What is IRSA and why does it matter?"**
A: IAM Roles for Service Accounts. Without it, every pod on a node shares the node's IAM role (overly permissive). With IRSA, each pod gets its own IAM role based on its ServiceAccount. This is least-privilege at the pod level — the app pod can read secrets but can't terminate instances.

**Q: "Explain the difference between Kustomize and Helm."**
A: Kustomize patches existing YAML (no templating, just strategic merge patches). Helm uses Go templates to generate YAML from values. Kustomize is simpler for small differences. Helm is more powerful for complex logic (conditionals, loops, dependencies). Many teams use both — Helm for packaging, Kustomize for last-mile patches in ArgoCD.

**Q: "What happens when a node dies in your setup?"**
A: PDB ensures at least 1 pod survives. Pod anti-affinity means replicas are on different nodes. HPA maintains minimum replicas. Karpenter detects pending pods and provisions a new node in ~60 seconds. The app stays available throughout because traffic shifts to surviving pods via the Service.

**Q: "How do you do zero-downtime deployments on Kubernetes?"**
A: Rolling update strategy with `maxSurge: 1, maxUnavailable: 0`. New pod starts → readiness probe passes → old pod receives SIGTERM → graceful shutdown (30s termination period) → old pod terminated. At no point are there fewer healthy pods than desired.

**Q: "Why is production ArgoCD set to manual sync?"**
A: Defense in depth. Auto-sync means any Git change immediately goes live. If someone merges a bad PR, production breaks instantly. Manual sync is the human approval gate. The engineer verifies staging is healthy, then clicks Sync. This is the same concept as the deploy approval gate in our GitHub Actions workflow — multiple layers of human judgment for production.

**Q: "How does Karpenter decide which instance type to launch?"**
A: It evaluates pending pod requirements (CPU, memory, GPU, architecture, OS), filters against the NodePool's allowed instance types, queries current Spot pricing, and launches the cheapest instance that fits. If Spot isn't available for the chosen type, it falls back to On-Demand. It selects in seconds, not minutes.
