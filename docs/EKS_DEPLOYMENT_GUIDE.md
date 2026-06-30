# EKS Deployment Guide — Step by Step

This guide documents the complete EKS deployment including every issue encountered and how it was resolved. Written for anyone who wants to replicate this or learn Kubernetes deployment on AWS.

---

## Table of Contents

1. [What We Deployed](#what-we-deployed)
2. [Prerequisites](#prerequisites)
3. [Step 1: Terraform — Create EKS Cluster](#step-1-terraform--create-eks-cluster)
4. [Step 2: Connect kubectl to EKS](#step-2-connect-kubectl-to-eks)
5. [Step 3: Install AWS Load Balancer Controller](#step-3-install-aws-load-balancer-controller)
6. [Step 4: Deploy the App with Helm](#step-4-deploy-the-app-with-helm)
7. [Step 5: Expose Externally](#step-5-expose-externally)
8. [Step 6: Run Migrations](#step-6-run-migrations)
9. [Troubleshooting (Every Issue We Hit)](#troubleshooting)
10. [Commands Reference](#commands-reference)
11. [Architecture Diagram](#architecture-diagram)
12. [Cost Breakdown](#cost-breakdown)
13. [Teardown](#teardown)

---

## What We Deployed

```
EKS Cluster (church-cms-staging)
├── 2 Worker Nodes (t3.medium Spot instances)
├── 2 App Pods (ghcr.io/bankolejohn/church-idea:latest)
├── AWS Load Balancer Controller (manages NLB/ALB creation)
├── NLB (Network Load Balancer — internet-facing)
├── RDS PostgreSQL (private subnet, Multi-AZ disabled for staging)
└── Secrets (Kubernetes Secret for DATABASE_URL + JWT_SECRET)
```

**Live URL:** `http://k8s-churchcm-churchcm-85989769bc-a7b203a155b9c87a.elb.us-east-1.amazonaws.com`

---

## Prerequisites

| Tool | Version Used | Install |
|------|-------------|---------|
| Terraform | v1.15.7 | [hashicorp.com/terraform](https://developer.hashicorp.com/terraform/install) |
| AWS CLI | v2.x | `brew install awscli` |
| kubectl | v1.30+ | `brew install kubectl` |
| Helm | v3.x | `brew install helm` |

---

## Step 1: Terraform — Create EKS Cluster

```bash
cd infrastructure/terraform/environments/eks

# Create secrets (hex passwords only — no special chars that break RDS)
cat > terraform.tfvars << EOF
db_username = "churchadmin"
db_password = "$(openssl rand -hex 16)"
jwt_secret  = "$(openssl rand -hex 32)"
EOF

# Initialize
terraform init

# Preview (expected: 44 resources)
terraform plan

# Deploy (~15 minutes — EKS cluster is slow)
terraform apply
```

**What gets created (44 resources):**
- VPC (10.3.0.0/16) with public + private subnets
- NAT Gateway (required for private subnet internet access)
- EKS cluster (Kubernetes control plane — managed by AWS)
- OIDC provider (for IRSA — pod-level IAM roles)
- Managed node group (2x t3.medium Spot instances)
- Core add-ons: CoreDNS, kube-proxy, vpc-cni
- Karpenter IAM roles (for future intelligent autoscaling)
- RDS PostgreSQL in private subnets
- Secrets Manager entries

---

## Step 2: Connect kubectl to EKS

```bash
# Configure kubectl to talk to the cluster
aws eks update-kubeconfig --name church-cms-staging --region us-east-1

# Verify — should show 2 nodes
kubectl get nodes
```

**What `update-kubeconfig` does:**
- Adds a new context to `~/.kube/config`
- Configures authentication (uses your AWS CLI credentials via the `aws eks get-token` command)
- Sets the cluster endpoint and CA certificate

---

## Step 3: Install AWS Load Balancer Controller

**Why:** Kubernetes doesn't know how to create AWS load balancers natively. This controller watches for Service/Ingress resources and creates ALBs/NLBs automatically.

```bash
# Add the EKS Helm chart repo
helm repo add eks https://aws.github.io/eks-charts
helm repo update

# Get VPC ID
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=church-cms-staging-vpc" --query 'Vpcs[0].VpcId' --output text)

# Install the controller
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --namespace kube-system \
  --set clusterName=church-cms-staging \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region=us-east-1 \
  --set vpcId=$VPC_ID
```

**Then set up IRSA (IAM permissions for the controller):**

```bash
# Download the IAM policy
curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.1/docs/install/iam_policy.json

# Create the policy
aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json

# Get OIDC URL and account ID
OIDC_URL=$(aws eks describe-cluster --name church-cms-staging --query 'cluster.identity.oidc.issuer' --output text | sed 's|https://||')
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create trust policy
cat > lb-trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_URL}"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${OIDC_URL}:aud": "sts.amazonaws.com",
        "${OIDC_URL}:sub": "system:serviceaccount:kube-system:aws-load-balancer-controller"
      }
    }
  }]
}
EOF

# Create the role
aws iam create-role \
  --role-name AWSLoadBalancerControllerRole \
  --assume-role-policy-document file://lb-trust-policy.json

# Attach policies
aws iam attach-role-policy \
  --role-name AWSLoadBalancerControllerRole \
  --policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/AWSLoadBalancerControllerIAMPolicy

aws iam attach-role-policy \
  --role-name AWSLoadBalancerControllerRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess

# Annotate the service account
kubectl annotate serviceaccount aws-load-balancer-controller \
  -n kube-system \
  eks.amazonaws.com/role-arn=arn:aws:iam::${ACCOUNT_ID}:role/AWSLoadBalancerControllerRole \
  --overwrite

# Restart controller to pick up credentials
kubectl rollout restart deployment aws-load-balancer-controller -n kube-system
```

---

## Step 4: Deploy the App with Helm

```bash
# Create namespace
kubectl create namespace church-cms-staging

# Get RDS endpoint
RDS_ENDPOINT=$(cd infrastructure/terraform/environments/eks && terraform output -raw rds_endpoint)
DB_PASS=$(grep db_password infrastructure/terraform/environments/eks/terraform.tfvars | sed "s/.*= *\"//;s/\"//")
JWT=$(grep jwt_secret infrastructure/terraform/environments/eks/terraform.tfvars | sed "s/.*= *\"//;s/\"//")

# Create Kubernetes secret
kubectl create secret generic church-cms-secrets \
  --namespace church-cms-staging \
  --from-literal=DATABASE_URL="postgresql://churchadmin:${DB_PASS}@${RDS_ENDPOINT}/churchdb" \
  --from-literal=JWT_SECRET="${JWT}"

# Deploy with Helm
helm install church-cms ./helm/church-cms \
  --namespace church-cms-staging \
  --set image.repository=ghcr.io/bankolejohn/church-idea \
  --set image.tag=latest \
  --set ingress.enabled=false \
  --set config.DB_SSL=true \
  --set config.NODE_ENV=staging \
  --set config.OTEL_ENABLED=false \
  --set config.ENABLE_HTTPS=false

# Verify pods are running
kubectl get pods -n church-cms-staging
# Expected: 2 pods with STATUS "Running" and READY "1/1"
```

---

## Step 5: Expose Externally

```bash
# Tag public subnets for LB discovery (do each one separately)
PUBLIC_SUBNET_1=<your-public-subnet-1-id>
PUBLIC_SUBNET_2=<your-public-subnet-2-id>

aws ec2 create-tags --resources $PUBLIC_SUBNET_1 --tags Key=kubernetes.io/role/elb,Value=1
aws ec2 create-tags --resources $PUBLIC_SUBNET_2 --tags Key=kubernetes.io/role/elb,Value=1

# Create internet-facing LoadBalancer service
kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: church-cms-external
  namespace: church-cms-staging
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
    service.beta.kubernetes.io/aws-load-balancer-type: external
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
spec:
  type: LoadBalancer
  selector:
    app.kubernetes.io/name: church-cms
    app.kubernetes.io/instance: church-cms
  ports:
    - port: 80
      targetPort: 3000
      protocol: TCP
EOF

# Wait for external IP (1-2 minutes)
kubectl get svc church-cms-external -n church-cms-staging -w

# Open the EKS cluster security group to allow traffic on port 3000
EKS_SG=$(aws eks describe-cluster --name church-cms-staging --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $EKS_SG \
  --protocol tcp \
  --port 3000 \
  --cidr 0.0.0.0/0
```

---

## Step 6: Run Migrations

```bash
kubectl run migrate --rm -it --restart=Never \
  --namespace church-cms-staging \
  --image=ghcr.io/bankolejohn/church-idea:latest \
  --env="DATABASE_URL=$(kubectl get secret church-cms-secrets -n church-cms-staging -o jsonpath='{.data.DATABASE_URL}' | base64 -d)" \
  --env="DB_SSL=true" \
  --command -- sh -c "node db/migrate.js && node db/seed.js"
```

---

## Troubleshooting

### Issue 1: RDS Password Contains Invalid Characters

**Error:** `InvalidParameterValue: The parameter MasterUserPassword is not a valid password`

**Cause:** `openssl rand -base64` generates `/`, `+`, `=` which RDS rejects.

**Fix:** Use `openssl rand -hex 16` (produces only 0-9a-f characters).

---

### Issue 2: Secrets Manager Name Conflict (7-Day Deletion Window)

**Error:** `You can't create this secret because a secret with this name is already scheduled for deletion`

**Cause:** Previous staging deployment created secrets with the same name. AWS keeps deleted secrets for 7 days.

**Fix:**
```bash
aws secretsmanager restore-secret --secret-id "church-cms/staging/database-url"
aws secretsmanager restore-secret --secret-id "church-cms/staging/jwt-secret"
terraform import 'module.secrets.aws_secretsmanager_secret.database_url' <ARN>
terraform import 'module.secrets.aws_secretsmanager_secret.jwt_secret' <ARN>
terraform apply
```

---

### Issue 3: Pods 0/1 Ready — Database Connection Timeout

**Error in logs:** `Connection terminated due to connection timeout`

**Cause:** EKS nodes have a different security group than ECS tasks. The RDS security group only allowed connections from the ECS security group — not the EKS cluster security group.

**How I debugged:**
```bash
# Check pod logs
kubectl logs -n church-cms-staging -l app.kubernetes.io/name=church-cms --tail=10
# Saw: "Database health check failed" + "Connection terminated"

# Identified the EKS cluster SG
aws eks describe-cluster --name church-cms-staging --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text
# sg-0ca55dc93ceec539e

# Identified the RDS SG
aws ec2 describe-security-groups --filters "Name=tag:Name,Values=church-cms-staging-rds-sg" --query 'SecurityGroups[0].GroupId' --output text
# sg-06c367ad2ec1ad490
```

**Fix:** Allow EKS cluster SG to access RDS on port 5432:
```bash
aws ec2 authorize-security-group-ingress \
  --group-id sg-06c367ad2ec1ad490 \
  --protocol tcp \
  --port 5432 \
  --source-group sg-0ca55dc93ceec539e
```

**Then restart pods:**
```bash
kubectl rollout restart deployment church-cms -n church-cms-staging
```

---

### Issue 4: LoadBalancer External-IP Stuck "Pending"

**Error in events:** `no EC2 IMDS role found, operation error ec2imds: GetMetadata, canceled`

**Cause:** The AWS Load Balancer Controller didn't have IAM permissions. It runs as a pod and needs IRSA (IAM Role for Service Account) to create AWS resources.

**Fix:** Create IAM role with trust policy, attach LB controller policy + EC2 read access, annotate the service account. (See Step 3 above for full commands.)

---

### Issue 5: LoadBalancer Created as "Internal" (Unreachable from Internet)

**Error:** `curl: (28) Connection timed out`

**Cause:** Public subnets weren't tagged with `kubernetes.io/role/elb=1`. The LB controller couldn't find public subnets, so it defaulted to private (internal).

**How I debugged:**
```bash
# Check LB scheme
aws elbv2 describe-load-balancers --query "LoadBalancers[?DNSName=='<lb-dns>'].Scheme" --output text
# Result: "internal" — that's the problem
```

**Fix:**
1. Tag public subnets: `aws ec2 create-tags --resources <subnet-id> --tags Key=kubernetes.io/role/elb,Value=1`
2. Delete the internal service
3. Recreate with annotation: `service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing`

---

### Issue 6: NLB Created But Still Timing Out

**Error:** `curl: (28) Connection timed out after 10004 milliseconds`

**Cause:** NLB uses IP target type (traffic goes directly to pod IPs). The EKS cluster security group didn't allow inbound traffic on port 3000 from the internet.

**Key insight:** Unlike ALB, NLB doesn't have its own security group. Traffic passes through to the TARGET's security group. So the node/pod SG must allow the traffic.

**Fix:**
```bash
aws ec2 authorize-security-group-ingress \
  --group-id <eks-cluster-sg> \
  --protocol tcp \
  --port 3000 \
  --cidr 0.0.0.0/0
```

---

### Issue 7: Page Loads But No CSS (Unstyled HTML)

**Error:** Browser shows raw HTML without any styling.

**Cause:** Helmet.js `upgrade-insecure-requests` CSP directive was active. The app was served over HTTP, but this header told the browser to request all sub-resources (CSS, JS) over HTTPS — which failed silently.

**How I knew:** Same pattern we saw in the ECS deployment months ago. HTML loads (it's inline), but external resources (CSS files) get blocked.

**Fix:**
```bash
helm upgrade church-cms ./helm/church-cms \
  --namespace church-cms-staging \
  --set config.ENABLE_HTTPS=false \
  ...other flags...
```

---

## Commands Reference

### kubectl Essentials

| Command | What It Does |
|---------|-------------|
| `kubectl get pods -n church-cms-staging` | List pods and their status |
| `kubectl get svc -n church-cms-staging` | List services (shows external IPs) |
| `kubectl logs -n church-cms-staging -l app.kubernetes.io/name=church-cms` | View app logs |
| `kubectl describe pod <name> -n church-cms-staging` | Detailed pod info (events, probes) |
| `kubectl exec -it <pod> -n church-cms-staging -- sh` | Shell into a running pod |
| `kubectl rollout restart deployment/church-cms -n church-cms-staging` | Restart all pods |
| `kubectl port-forward svc/church-cms 8080:80 -n church-cms-staging` | Access app locally |
| `kubectl get events -n church-cms-staging --sort-by=.lastTimestamp` | Recent events |
| `kubectl run migrate --rm -it --restart=Never ...` | Run a one-off migration job |

### Helm Essentials

| Command | What It Does |
|---------|-------------|
| `helm install <name> <chart> -n <ns>` | Deploy an app |
| `helm upgrade <name> <chart> -n <ns> --set key=val` | Update config/image |
| `helm list -n <ns>` | Show deployed releases |
| `helm uninstall <name> -n <ns>` | Remove the deployment |
| `helm template <chart> --set key=val` | Preview generated YAML (dry-run) |

---

## Architecture Diagram

```
Internet
    │
    ▼ (Port 80)
┌─────────────────────────────────────────────────────────┐
│  NLB (Network Load Balancer — internet-facing)          │
│  k8s-churchcm-...elb.us-east-1.amazonaws.com           │
└────────────────────────┬────────────────────────────────┘
                         │ IP target type (direct to pods)
                         ▼
┌─────────────── EKS Cluster ─────────────────────────────┐
│                                                          │
│  ┌─── Node 1 (t3.medium Spot) ────────────────────────┐│
│  │  Pod: church-cms-xxx  (port 3000)                   ││
│  └─────────────────────────────────────────────────────┘│
│  ┌─── Node 2 (t3.medium Spot) ────────────────────────┐│
│  │  Pod: church-cms-yyy  (port 3000)                   ││
│  └─────────────────────────────────────────────────────┘│
│                         │                                │
│                         ▼ (port 5432, private subnet)    │
│  ┌──────────────────────────────────────────────────┐   │
│  │  RDS PostgreSQL (church-cms-staging-db)           │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

---

## Cost Breakdown

| Service | Monthly Cost |
|---------|-------------|
| EKS control plane | $73 |
| 2x t3.medium Spot nodes | ~$30 |
| NAT Gateway | $32 |
| RDS db.t3.micro | $15 |
| NLB | $16 |
| **Total** | **~$170/month** |

---

## Teardown

```bash
# Delete Kubernetes resources first
kubectl delete svc church-cms-external -n church-cms-staging
helm uninstall church-cms -n church-cms-staging
helm uninstall aws-load-balancer-controller -n kube-system

# Delete IAM resources
aws iam detach-role-policy --role-name AWSLoadBalancerControllerRole --policy-arn arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess
aws iam detach-role-policy --role-name AWSLoadBalancerControllerRole --policy-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/AWSLoadBalancerControllerIAMPolicy
aws iam delete-role --role-name AWSLoadBalancerControllerRole

# Destroy Terraform infrastructure
cd infrastructure/terraform/environments/eks
terraform destroy
```

---

## Key Lessons

1. **EKS security groups are separate from ECS** — RDS allowed ECS SG but not EKS SG. Always check cross-service connectivity.
2. **NLBs don't have their own security group** — traffic goes directly to targets. Target SG must allow inbound from internet.
3. **Subnet tags are required** for LB controller discovery: `kubernetes.io/role/elb=1` (public) and `kubernetes.io/role/internal-elb=1` (private).
4. **IRSA is mandatory** for any pod that calls AWS APIs — without it, the pod has no credentials.
5. **`ENABLE_HTTPS=false`** is critical when serving over HTTP — Helmet.js CSP blocks resources otherwise.
6. **`openssl rand -hex`** is safer than `-base64` for passwords — no special characters that break services.
7. **Partial failures are normal** — Terraform apply, fix issues, apply again. Don't panic.


---

## Troubleshooting: Terraform Destroy Stuck on VPC

### Issue 8: VPC Has Dependencies — Cannot Delete

**Error:**
```
Error: deleting EC2 VPC (vpc-0c78d8963f9f5a6fa): DependencyViolation:
The vpc has dependencies and cannot be deleted.
```

**Cause:** When you skip deleting Kubernetes-created resources (NLB, services) BEFORE running `terraform destroy`, the VPC ends up with leftover resources that Terraform didn't create and doesn't know about:
- Network Load Balancers (created by AWS Load Balancer Controller)
- Security Groups (created by Kubernetes for service networking)
- Network Interfaces (ENIs attached to NLBs)

AWS won't delete a VPC until ALL resources inside it are gone.

**How to debug — find what's left in the VPC:**

```bash
VPC_ID="vpc-XXXXX"  # Replace with your VPC ID from the error

# Check for leftover security groups
aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[?GroupName!=`default`].{ID:GroupId,Name:GroupName}' --output table

# Check for leftover network interfaces
aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'NetworkInterfaces[*].{ID:NetworkInterfaceId,Status:Status,Description:Description}' --output table

# Check for leftover load balancers
aws elbv2 describe-load-balancers \
  --query "LoadBalancers[?VpcId=='$VPC_ID'].{ARN:LoadBalancerArn,Name:LoadBalancerName}" --output table
```

**How to fix — delete in this order:**

```bash
# 1. Delete load balancers first (they hold ENIs)
aws elbv2 delete-load-balancer --load-balancer-arn <arn-from-above>
sleep 60  # Wait for ENIs to release

# 2. Delete leftover target groups
aws elbv2 describe-target-groups --query 'TargetGroups[?contains(TargetGroupName, `churchcm`)].TargetGroupArn' --output text | while read ARN; do
  aws elbv2 delete-target-group --target-group-arn "$ARN"
done

# 3. Delete leftover ENIs (must be "available" status — not "in-use")
aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'NetworkInterfaces[?Status==`available`].NetworkInterfaceId' --output text | while read ENI; do
  aws ec2 delete-network-interface --network-interface-id "$ENI"
done

# 4. Delete leftover security groups (created by K8s, not Terraform)
aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[?GroupName!=`default`].GroupId' --output text | while read SG; do
  aws ec2 delete-security-group --group-id "$SG"
done

# 5. Now terraform destroy will work
terraform destroy
```

**The correct teardown order (to avoid this entirely):**

```
1. kubectl delete services (removes NLBs)        ← Most people forget this
2. helm uninstall (removes K8s deployments)
3. Wait 60 seconds (AWS releases ENIs)
4. terraform destroy (removes infra)
5. Clean up manual IAM roles
```

**Lesson:** Kubernetes creates AWS resources (load balancers, security groups) that live OUTSIDE Terraform's state. If you destroy the cluster without cleaning these up first, they become orphaned and block VPC deletion. Always delete K8s services before destroying infrastructure.

---

## Karpenter — Intelligent Node Autoscaling

### What Karpenter Is

Karpenter is a Kubernetes node autoscaler built by AWS. It replaces the traditional Cluster Autoscaler with a smarter, faster approach.

### Why Karpenter Exists (Problem with Cluster Autoscaler)

**Traditional Cluster Autoscaler:**
```
Pod pending (no capacity) → Check node groups → Increase ASG desired count
→ ASG launches pre-defined instance type → Node boots → Pod scheduled
Time: 2-5 minutes
```

**Problems:**
- Slow (2-5 minutes per scale event)
- Wasteful (fixed instance types — if you need 1 CPU, you might get 4)
- Rigid (must pre-define node groups per instance type)

**Karpenter:**
```
Pod pending → Evaluate pod requirements (CPU, memory, arch)
→ Query Spot pricing → Launch cheapest instance that fits → Pod scheduled
Time: ~60 seconds
```

### How Karpenter Works

1. **Watches for unschedulable pods** (pending because no node has capacity)
2. **Evaluates requirements** (how much CPU/memory does this pod need?)
3. **Selects the cheapest instance** from a wide range of allowed types
4. **Prefers Spot instances** (70% cheaper than On-Demand)
5. **Provisions in ~60 seconds** (vs 2-5 minutes for Cluster Autoscaler)
6. **Consolidates when underutilized** (moves pods, terminates empty nodes)

### What We Created (But Didn't Activate)

**In Terraform (`modules/eks/karpenter.tf`):**
- IAM role for Karpenter controller (IRSA — runs as a pod in the cluster)
- IAM role for Karpenter-provisioned nodes (EC2 instance profile)
- Permissions to launch/terminate EC2 instances

**In Kubernetes (`kubernetes/karpenter/nodepool.yaml`):**
- NodePool definition (what instance types are allowed)
- EC2NodeClass (what AMI, subnets, security groups to use)

### Why We Didn't Activate It

For a 2-node staging cluster, Karpenter is overkill:
- We already have a managed node group with 2 nodes
- Traffic is minimal — no scaling needed
- Adding Karpenter means removing the managed node group (replacing one with the other)
- The IAM infrastructure is ready — activating it is a one-step Helm install

### How to Activate Karpenter (When Ready)

```bash
# 1. Install Karpenter via Helm
helm repo add karpenter https://charts.karpenter.sh
helm repo update

CLUSTER_ENDPOINT=$(aws eks describe-cluster --name church-cms-staging --query 'cluster.endpoint' --output text)
KARPENTER_ROLE_ARN=$(aws iam get-role --role-name church-cms-staging-karpenter-controller --query 'Role.Arn' --output text)

helm install karpenter karpenter/karpenter \
  --namespace karpenter --create-namespace \
  --set clusterName=church-cms-staging \
  --set clusterEndpoint=$CLUSTER_ENDPOINT \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=$KARPENTER_ROLE_ARN

# 2. Apply the NodePool (defines allowed instance types)
kubectl apply -f kubernetes/karpenter/nodepool.yaml

# 3. Delete the managed node group (Karpenter replaces it)
aws eks delete-nodegroup \
  --cluster-name church-cms-staging \
  --nodegroup-name church-cms-staging-nodes
# Karpenter will immediately provision new nodes for the existing pods
```

### NodePool Configuration Explained

```yaml
requirements:
  # Instance categories: compute, general purpose, burstable
  - key: karpenter.k8s.aws/instance-category
    operator: In
    values: ["c", "m", "t"]

  # Sizes: medium to xlarge (avoid tiny instances — K8s overhead needs ~0.5 CPU)
  - key: karpenter.k8s.aws/instance-size
    operator: In
    values: ["medium", "large", "xlarge"]

  # Prefer Spot (70% cheaper), fallback to On-Demand
  - key: karpenter.sh/capacity-type
    operator: In
    values: ["spot", "on-demand"]
```

**Why wide instance variety:** More types = more Spot availability. If `t3.medium` Spot isn't available, Karpenter tries `c5.medium`, then `m5.medium`, etc. It always picks the cheapest option available RIGHT NOW.

### Consolidation (Cost Saving)

```yaml
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 60s
```

When traffic drops (e.g., nighttime), Karpenter:
1. Identifies nodes running below capacity
2. Checks if pods can fit on fewer nodes
3. Cordons the underutilized node (no new pods)
4. Drains pods (moves them to other nodes, respecting PDBs)
5. Terminates the empty node (stops paying for it)

This is automatic cost optimization — your cluster shrinks at night and grows during the day.

### What to Say in Interviews

"I configured Karpenter with IAM roles and NodePool definitions. The cluster uses a managed node group for simplicity in staging, but Karpenter is ready to activate for production where we need sub-minute scaling and Spot instance diversity for cost optimization. Karpenter can provision the right-sized node in 60 seconds versus 2-5 minutes for Cluster Autoscaler."

---
