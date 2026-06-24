###############################################
# CodeDeploy Blue/Green Module for ECS
#
# HOW BLUE/GREEN WORKS ON ECS:
#
# 1. You have TWO target groups (blue = current, green = new)
# 2. A deploy starts → ECS launches new tasks in the GREEN target group
# 3. CodeDeploy shifts traffic from blue → green according to a strategy:
#    - AllAtOnce: instant switch (fast but risky)
#    - Linear10PercentEvery1Minutes: gradual shift (safe)
#    - Canary10Percent5Minutes: 10% first, wait 5min, then 100% (safest)
# 4. If CloudWatch alarms fire during the shift → auto rollback
# 5. If all good → green becomes the new "blue" (blue tasks terminate)
#
# WHY THIS MATTERS:
# Rolling updates (what we had before) replace ALL tasks gradually.
# If the new version is broken, some users are already affected before
# the circuit breaker kicks in.
#
# Blue/Green with canary means:
# - Only 10% of users see the new version first
# - You monitor for 5 minutes
# - If error rate spikes → instant rollback, 90% of users never noticed
#
###############################################

# ─── CodeDeploy Application ──────────────────────────────────────
resource "aws_codedeploy_app" "ecs" {
  name             = "${var.project_name}-${var.environment}"
  compute_platform = "ECS"

  tags = {
    Name        = "${var.project_name}-${var.environment}-codedeploy"
    Environment = var.environment
  }
}

# ─── IAM Role for CodeDeploy ─────────────────────────────────────
resource "aws_iam_role" "codedeploy" {
  name = "${var.project_name}-${var.environment}-codedeploy-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "codedeploy.amazonaws.com"
      }
    }]
  })

  tags = {
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "codedeploy_ecs" {
  role       = aws_iam_role.codedeploy.name
  policy_arn = "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS"
}

# ─── CloudWatch Alarms (CodeDeploy monitors these) ───────────────
# If any of these fire during deployment → automatic rollback

resource "aws_cloudwatch_metric_alarm" "high_5xx" {
  alarm_name          = "${var.project_name}-${var.environment}-deploy-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "High 5xx errors during deployment — triggers rollback"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_green_arn_suffix
  }

  tags = {
    Environment = var.environment
    Purpose     = "deployment-gate"
  }
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${var.project_name}-${var.environment}-deploy-unhealthy"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "Unhealthy targets during deployment — triggers rollback"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_green_arn_suffix
  }

  tags = {
    Environment = var.environment
    Purpose     = "deployment-gate"
  }
}

resource "aws_cloudwatch_metric_alarm" "high_latency" {
  alarm_name          = "${var.project_name}-${var.environment}-deploy-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "p95"
  threshold           = 3
  alarm_description   = "High latency during deployment — triggers rollback"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_green_arn_suffix
  }

  tags = {
    Environment = var.environment
    Purpose     = "deployment-gate"
  }
}

# ─── Deployment Group ─────────────────────────────────────────────
resource "aws_codedeploy_deployment_group" "ecs" {
  app_name               = aws_codedeploy_app.ecs.name
  deployment_group_name  = "${var.project_name}-${var.environment}-dg"
  deployment_config_name = var.deployment_config
  service_role_arn       = aws_iam_role.codedeploy.arn

  # Auto-rollback on deployment failure OR alarm trigger
  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]
  }

  # CloudWatch alarms to monitor during deployment
  alarm_configuration {
    alarms  = [
      aws_cloudwatch_metric_alarm.high_5xx.alarm_name,
      aws_cloudwatch_metric_alarm.unhealthy_hosts.alarm_name,
      aws_cloudwatch_metric_alarm.high_latency.alarm_name,
    ]
    enabled = true
  }

  # Blue/Green deployment style
  deployment_style {
    deployment_option = "WITH_TRAFFIC_CONTROL"
    deployment_type   = "BLUE_GREEN"
  }

  # ECS service to deploy
  ecs_service {
    cluster_name = var.ecs_cluster_name
    service_name = var.ecs_service_name
  }

  # Traffic routing via ALB
  load_balancer_info {
    target_group_pair_info {
      prod_traffic_route {
        listener_arns = var.listener_arns
      }

      # Optional: test listener for canary validation before prod traffic shifts
      dynamic "test_traffic_route" {
        for_each = var.test_listener_arn != "" ? [1] : []
        content {
          listener_arns = [var.test_listener_arn]
        }
      }

      target_group {
        name = var.target_group_blue_name
      }

      target_group {
        name = var.target_group_green_name
      }
    }
  }

  # How long to keep the old (blue) tasks alive after traffic shifts
  # This is your rollback window — if something goes wrong within this time,
  # CodeDeploy can instantly switch back to blue (tasks are still running)
  blue_green_deployment_config {
    terminate_blue_instances_on_deployment_success {
      action                           = "TERMINATE"
      termination_wait_time_in_minutes = var.termination_wait_minutes
    }

    deployment_ready_option {
      action_on_timeout = var.auto_proceed ? "CONTINUE_DEPLOYMENT" : "STOP_DEPLOYMENT"
      wait_time_in_minutes = var.auto_proceed ? 0 : var.manual_approval_wait_minutes
    }
  }

  tags = {
    Environment = var.environment
  }
}
