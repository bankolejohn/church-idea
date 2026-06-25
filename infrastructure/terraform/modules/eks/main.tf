###############################################
# EKS Cluster Module
#
# WHAT THIS CREATES:
# - EKS control plane (managed Kubernetes API server)
# - IAM roles for the cluster and nodes (IRSA-enabled)
# - OIDC provider (allows pods to assume IAM roles)
# - Managed node group (EC2 instances that run your pods)
# - Security groups (control plane ↔ node communication)
# - Core add-ons (CoreDNS, kube-proxy, VPC CNI)
#
# ARCHITECTURE:
#
#   ┌─────────────────────────────────────────────┐
#   │              EKS Control Plane               │
#   │         (Managed by AWS — HA, patched)       │
#   │                                              │
#   │   API Server │ etcd │ Controller Manager     │
#   └──────────────────────┬───────────────────────┘
#                          │ (ENI in your VPC)
#                          │
#   ┌──────────────────────┴───────────────────────┐
#   │              Worker Nodes                     │
#   │         (Managed Node Group)                  │
#   │                                              │
#   │   ┌─────────┐  ┌─────────┐  ┌─────────┐   │
#   │   │  Pod    │  │  Pod    │  │  Pod    │   │
#   │   │ (app)   │  │ (app)   │  │ (otel)  │   │
#   │   └─────────┘  └─────────┘  └─────────┘   │
#   └──────────────────────────────────────────────┘
#
# WHY EKS (not self-managed K8s):
# - Control plane is fully managed (AWS patches, HA across 3 AZs)
# - Integrated with AWS IAM (IRSA — pods get IAM roles)
# - Managed node groups (AWS handles OS patching, draining)
# - Native ALB/NLB integration via AWS Load Balancer Controller
# - CloudWatch Container Insights built-in
#
###############################################

# ─── EKS Cluster IAM Role ────────────────────────────────────────
resource "aws_iam_role" "cluster" {
  name = "${var.project_name}-${var.environment}-eks-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "eks.amazonaws.com"
      }
    }]
  })

  tags = {
    Name        = "${var.project_name}-${var.environment}-eks-cluster-role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "cluster_policy" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_iam_role_policy_attachment" "cluster_vpc_controller" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController"
}

# ─── EKS Cluster ─────────────────────────────────────────────────
resource "aws_eks_cluster" "main" {
  name     = "${var.project_name}-${var.environment}"
  role_arn = aws_iam_role.cluster.arn
  version  = var.cluster_version

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = var.endpoint_public_access
    security_group_ids      = [aws_security_group.cluster.id]
  }

  # Enable logging for audit and troubleshooting
  enabled_cluster_log_types = var.environment == "prod" ? [
    "api", "audit", "authenticator", "controllerManager", "scheduler"
  ] : ["api", "audit"]

  tags = {
    Name        = "${var.project_name}-${var.environment}"
    Environment = var.environment
  }

  depends_on = [
    aws_iam_role_policy_attachment.cluster_policy,
    aws_iam_role_policy_attachment.cluster_vpc_controller,
  ]
}

# ─── OIDC Provider (for IRSA — IAM Roles for Service Accounts) ───
# This allows Kubernetes pods to assume IAM roles without
# needing AWS credentials in the container.
data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]

  tags = {
    Name        = "${var.project_name}-${var.environment}-eks-oidc"
    Environment = var.environment
  }
}

# ─── Cluster Security Group ──────────────────────────────────────
resource "aws_security_group" "cluster" {
  name        = "${var.project_name}-${var.environment}-eks-cluster-sg"
  description = "Security group for EKS cluster control plane"
  vpc_id      = var.vpc_id

  # Allow all outbound (control plane needs to communicate with nodes)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-eks-cluster-sg"
    Environment = var.environment
  }
}

# ─── Node Group IAM Role ─────────────────────────────────────────
resource "aws_iam_role" "node_group" {
  name = "${var.project_name}-${var.environment}-eks-node-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })

  tags = {
    Name        = "${var.project_name}-${var.environment}-eks-node-role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_ecr" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "node_ssm" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ─── Managed Node Group ──────────────────────────────────────────
resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.project_name}-${var.environment}-nodes"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = var.private_subnet_ids

  instance_types = var.node_instance_types
  capacity_type  = var.capacity_type  # ON_DEMAND or SPOT

  scaling_config {
    desired_size = var.node_desired_size
    min_size     = var.node_min_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    role        = "worker"
    environment = var.environment
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-node"
    Environment = var.environment
    # Required for Karpenter discovery
    "karpenter.sh/discovery" = "${var.project_name}-${var.environment}"
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr,
    aws_iam_role_policy_attachment.node_ssm,
  ]
}

# ─── EKS Add-ons ─────────────────────────────────────────────────
# These are cluster-essential components managed by AWS

resource "aws_eks_addon" "coredns" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "coredns"

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_node_group.main]
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "kube-proxy"

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "vpc-cni"

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
}
