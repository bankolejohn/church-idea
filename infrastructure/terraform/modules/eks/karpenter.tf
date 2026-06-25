###############################################
# Karpenter — Intelligent Node Autoscaling
#
# WHAT KARPENTER DOES:
# Traditional Cluster Autoscaler: "I have pending pods → add a node
# from a pre-defined node group." Slow (2-5 minutes).
#
# Karpenter: "I have pending pods that need 2 CPU and 4GB RAM →
# I'll provision EXACTLY the right instance type in seconds."
#
# WHY KARPENTER > CLUSTER AUTOSCALER:
# - Faster: provisions nodes in ~60 seconds (vs 2-5 minutes)
# - Smarter: selects optimal instance type per workload
# - Cheaper: consolidates underutilized nodes automatically
# - Simpler: no ASG/node group management needed
#
# HOW IT WORKS:
# 1. Pod is pending (no node with enough resources)
# 2. Karpenter evaluates pod requirements (CPU, memory, GPU, AZ, etc.)
# 3. Karpenter launches the cheapest instance that fits
# 4. Pod is scheduled on the new node
# 5. When load drops, Karpenter consolidates (moves pods, terminates empty nodes)
#
# PREREQUISITE:
# Karpenter is installed via Helm on the cluster AFTER the cluster exists.
# This Terraform file creates the IAM resources Karpenter needs.
###############################################

# ─── Karpenter Controller IAM Role (IRSA) ────────────────────────
# Karpenter runs as a pod in the cluster and needs permission to
# launch/terminate EC2 instances, manage ENIs, etc.

resource "aws_iam_role" "karpenter_controller" {
  name = "${var.project_name}-${var.environment}-karpenter-controller"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRoleWithWebIdentity"
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.eks.arn
      }
      Condition = {
        StringEquals = {
          "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:sub" = "system:serviceaccount:karpenter:karpenter"
          "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })

  tags = {
    Environment = var.environment
  }
}

resource "aws_iam_role_policy" "karpenter_controller" {
  name = "${var.project_name}-${var.environment}-karpenter-policy"
  role = aws_iam_role.karpenter_controller.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Karpenter"
        Effect = "Allow"
        Action = [
          "ec2:CreateLaunchTemplate",
          "ec2:CreateFleet",
          "ec2:CreateTags",
          "ec2:DescribeLaunchTemplates",
          "ec2:DescribeInstances",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeInstanceTypeOfferings",
          "ec2:DescribeAvailabilityZones",
          "ec2:DescribeImages",
          "ec2:DeleteLaunchTemplate",
          "ec2:RunInstances",
          "ec2:TerminateInstances",
          "iam:PassRole",
          "ssm:GetParameter",
          "pricing:GetProducts",
        ]
        Resource = "*"
      },
      {
        Sid    = "ConditionalEC2Termination"
        Effect = "Allow"
        Action = ["ec2:TerminateInstances"]
        Resource = "*"
        Condition = {
          StringLike = {
            "ec2:ResourceTag/karpenter.sh/discovery" = "${var.project_name}-${var.environment}"
          }
        }
      }
    ]
  })
}

# ─── Karpenter Node IAM Role ─────────────────────────────────────
# Nodes launched by Karpenter need their own IAM role
# (similar to the managed node group role but for Karpenter-provisioned nodes)

resource "aws_iam_role" "karpenter_node" {
  name = "${var.project_name}-${var.environment}-karpenter-node"

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
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "karpenter_node_worker" {
  role       = aws_iam_role.karpenter_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "karpenter_node_cni" {
  role       = aws_iam_role.karpenter_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "karpenter_node_ecr" {
  role       = aws_iam_role.karpenter_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "karpenter_node_ssm" {
  role       = aws_iam_role.karpenter_node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "karpenter_node" {
  name = "${var.project_name}-${var.environment}-karpenter-node"
  role = aws_iam_role.karpenter_node.name
}
