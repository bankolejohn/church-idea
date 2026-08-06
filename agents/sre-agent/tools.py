"""
Agent Tools — The actions the AI agent can take.

Each tool is a function the agent can call. Think of these as the agent's
"hands" — it can observe (read data) and act (make changes).

TOOL CATEGORIES:
1. DIAGNOSTIC (read-only, always safe)
   - check_health, check_ready, get_ecs_status, get_recent_logs, etc.

2. REMEDIATION (makes changes — requires guardrails)
   - restart_service, scale_service, etc.

3. COMMUNICATION (notifications)
   - notify_slack

GUARDRAILS:
- Diagnostic tools: always allowed (they only READ)
- Remediation tools: require confirmation if REQUIRE_HUMAN_APPROVAL=true
- Destructive tools (delete, terminate): NEVER automated — always escalate
"""

import time
import json
import requests
import boto3
from datetime import datetime, timedelta
from config import Config


# ─── AWS Clients ──────────────────────────────────────────────────
ecs_client = boto3.client("ecs", region_name=Config.AWS_REGION)
cloudwatch_client = boto3.client("cloudwatch", region_name=Config.AWS_REGION)
logs_client = boto3.client("logs", region_name=Config.AWS_REGION)
rds_client = boto3.client("rds", region_name=Config.AWS_REGION)
elbv2_client = boto3.client("elbv2", region_name=Config.AWS_REGION)


# ═══════════════════════════════════════════════════════════════════
# DIAGNOSTIC TOOLS (read-only — always safe)
# ═══════════════════════════════════════════════════════════════════


def check_health() -> dict:
    """Check if the application is alive (GET /health)."""
    try:
        response = requests.get(f"{Config.APP_URL}/health", timeout=10)
        return {
            "status": "healthy" if response.status_code == 200 else "unhealthy",
            "http_code": response.status_code,
            "response": response.json() if response.status_code == 200 else response.text,
        }
    except requests.exceptions.Timeout:
        return {"status": "timeout", "http_code": 0, "response": "Connection timed out"}
    except requests.exceptions.ConnectionError:
        return {"status": "unreachable", "http_code": 0, "response": "Connection refused"}
    except Exception as e:
        return {"status": "error", "http_code": 0, "response": str(e)}


def check_ready() -> dict:
    """Check if the database is connected (GET /ready)."""
    try:
        response = requests.get(f"{Config.APP_URL}/ready", timeout=10)
        return {
            "status": "ready" if response.status_code == 200 else "not_ready",
            "http_code": response.status_code,
            "response": response.json() if response.status_code == 200 else response.text,
        }
    except requests.exceptions.Timeout:
        return {"status": "timeout", "http_code": 0, "response": "Connection timed out"}
    except requests.exceptions.ConnectionError:
        return {"status": "unreachable", "http_code": 0, "response": "Connection refused"}
    except Exception as e:
        return {"status": "error", "http_code": 0, "response": str(e)}


def get_ecs_status() -> dict:
    """Get the current ECS service status (task counts, deployment state)."""
    try:
        response = ecs_client.describe_services(
            cluster=Config.ECS_CLUSTER,
            services=[Config.ECS_SERVICE],
        )
        service = response["services"][0]
        return {
            "desired_count": service["desiredCount"],
            "running_count": service["runningCount"],
            "pending_count": service["pendingCount"],
            "status": service["status"],
            "deployments": len(service["deployments"]),
            "events": [
                {"time": str(e["createdAt"]), "message": e["message"]}
                for e in service["events"][:5]
            ],
        }
    except Exception as e:
        return {"error": str(e)}


def get_recent_logs(minutes: int = 10, filter_pattern: str = "") -> dict:
    """Get recent application logs from CloudWatch."""
    try:
        start_time = int((datetime.utcnow() - timedelta(minutes=minutes)).timestamp() * 1000)
        end_time = int(datetime.utcnow().timestamp() * 1000)

        kwargs = {
            "logGroupName": Config.LOG_GROUP,
            "startTime": start_time,
            "endTime": end_time,
            "limit": 20,
            "interleaved": True,
        }
        if filter_pattern:
            kwargs["filterPattern"] = filter_pattern

        response = logs_client.filter_log_events(**kwargs)
        return {
            "log_count": len(response.get("events", [])),
            "logs": [
                {"timestamp": str(datetime.fromtimestamp(e["timestamp"] / 1000)), "message": e["message"][:500]}
                for e in response.get("events", [])[-10:]
            ],
        }
    except Exception as e:
        return {"error": str(e)}


def get_rds_status() -> dict:
    """Get database instance status."""
    try:
        response = rds_client.describe_db_instances(
            DBInstanceIdentifier=Config.RDS_INSTANCE
        )
        db = response["DBInstances"][0]
        return {
            "status": db["DBInstanceStatus"],
            "multi_az": db.get("MultiAZ", False),
            "publicly_accessible": db.get("PubliclyAccessible", False),
            "storage_allocated_gb": db.get("AllocatedStorage"),
            "engine": f"{db['Engine']} {db['EngineVersion']}",
        }
    except Exception as e:
        return {"error": str(e)}


def get_alb_health() -> dict:
    """Check target group health (are ECS tasks healthy from ALB perspective)."""
    try:
        # Find the target group
        tg_response = elbv2_client.describe_target_groups(
            Names=[f"{Config.APP_NAME}-prod-tg"]
        )
        if not tg_response["TargetGroups"]:
            return {"error": "Target group not found"}

        tg_arn = tg_response["TargetGroups"][0]["TargetGroupArn"]
        health_response = elbv2_client.describe_target_health(TargetGroupArn=tg_arn)

        targets = []
        for target in health_response["TargetHealthDescriptions"]:
            targets.append({
                "id": target["Target"]["Id"],
                "port": target["Target"]["Port"],
                "health": target["TargetHealth"]["State"],
                "reason": target["TargetHealth"].get("Reason", ""),
            })

        healthy = sum(1 for t in targets if t["health"] == "healthy")
        return {
            "total_targets": len(targets),
            "healthy": healthy,
            "unhealthy": len(targets) - healthy,
            "targets": targets,
        }
    except Exception as e:
        return {"error": str(e)}


def get_cpu_memory_metrics(minutes: int = 15) -> dict:
    """Get CPU and memory utilization for ECS service."""
    try:
        end_time = datetime.utcnow()
        start_time = end_time - timedelta(minutes=minutes)

        cpu_response = cloudwatch_client.get_metric_statistics(
            Namespace="AWS/ECS",
            MetricName="CPUUtilization",
            Dimensions=[
                {"Name": "ClusterName", "Value": Config.ECS_CLUSTER},
                {"Name": "ServiceName", "Value": Config.ECS_SERVICE},
            ],
            StartTime=start_time,
            EndTime=end_time,
            Period=300,
            Statistics=["Average", "Maximum"],
        )

        memory_response = cloudwatch_client.get_metric_statistics(
            Namespace="AWS/ECS",
            MetricName="MemoryUtilization",
            Dimensions=[
                {"Name": "ClusterName", "Value": Config.ECS_CLUSTER},
                {"Name": "ServiceName", "Value": Config.ECS_SERVICE},
            ],
            StartTime=start_time,
            EndTime=end_time,
            Period=300,
            Statistics=["Average", "Maximum"],
        )

        cpu_data = sorted(cpu_response["Datapoints"], key=lambda x: x["Timestamp"])
        memory_data = sorted(memory_response["Datapoints"], key=lambda x: x["Timestamp"])

        return {
            "cpu": {
                "current_avg": round(cpu_data[-1]["Average"], 2) if cpu_data else None,
                "current_max": round(cpu_data[-1]["Maximum"], 2) if cpu_data else None,
            },
            "memory": {
                "current_avg": round(memory_data[-1]["Average"], 2) if memory_data else None,
                "current_max": round(memory_data[-1]["Maximum"], 2) if memory_data else None,
            },
        }
    except Exception as e:
        return {"error": str(e)}


# ═══════════════════════════════════════════════════════════════════
# REMEDIATION TOOLS (makes changes — guardrailed)
# ═══════════════════════════════════════════════════════════════════


def restart_service() -> dict:
    """Force a new deployment (restarts all tasks with latest image).

    RISK LEVEL: LOW
    - Does NOT cause downtime (rolling restart)
    - New tasks start before old tasks stop
    - ECS circuit breaker rolls back if new tasks fail
    """
    try:
        response = ecs_client.update_service(
            cluster=Config.ECS_CLUSTER,
            service=Config.ECS_SERVICE,
            forceNewDeployment=True,
        )
        return {
            "action": "restart_service",
            "result": "success",
            "message": f"Forced new deployment for {Config.ECS_SERVICE}",
            "desired_count": response["service"]["desiredCount"],
        }
    except Exception as e:
        return {"action": "restart_service", "result": "failed", "error": str(e)}


def scale_service(desired_count: int) -> dict:
    """Scale the ECS service to a specific number of tasks.

    RISK LEVEL: MEDIUM
    - Scaling UP is always safe
    - Scaling DOWN could reduce availability
    - Scaling to 0 causes complete outage
    """
    if desired_count < 1:
        return {"action": "scale_service", "result": "blocked", "reason": "Cannot scale to 0 — would cause outage"}
    if desired_count > 10:
        return {"action": "scale_service", "result": "blocked", "reason": "Cannot scale above 10 — cost guardrail"}

    try:
        response = ecs_client.update_service(
            cluster=Config.ECS_CLUSTER,
            service=Config.ECS_SERVICE,
            desiredCount=desired_count,
        )
        return {
            "action": "scale_service",
            "result": "success",
            "message": f"Scaled {Config.ECS_SERVICE} to {desired_count} tasks",
            "previous_count": response["service"]["runningCount"],
            "new_desired": desired_count,
        }
    except Exception as e:
        return {"action": "scale_service", "result": "failed", "error": str(e)}


# ═══════════════════════════════════════════════════════════════════
# COMMUNICATION TOOLS
# ═══════════════════════════════════════════════════════════════════


def notify_slack(message: str, severity: str = "info") -> dict:
    """Send a notification to Slack."""
    if not Config.SLACK_WEBHOOK_URL:
        return {"action": "notify_slack", "result": "skipped", "reason": "No Slack webhook configured"}

    color_map = {"critical": "#d62728", "warning": "#ff7f0e", "info": "#2ca02c", "resolved": "#2ca02c"}

    payload = {
        "attachments": [{
            "color": color_map.get(severity, "#808080"),
            "title": f"SRE Agent — {severity.upper()}",
            "text": message,
            "footer": f"AI SRE Agent | {Config.APP_NAME}",
            "ts": int(time.time()),
        }]
    }

    try:
        response = requests.post(Config.SLACK_WEBHOOK_URL, json=payload, timeout=5)
        return {"action": "notify_slack", "result": "sent", "status_code": response.status_code}
    except Exception as e:
        return {"action": "notify_slack", "result": "failed", "error": str(e)}


# ═══════════════════════════════════════════════════════════════════
# TOOL REGISTRY (what the agent can call)
# ═══════════════════════════════════════════════════════════════════

TOOLS = {
    # Diagnostic (always safe)
    "check_health": {
        "function": check_health,
        "description": "Check if the application is alive by hitting GET /health",
        "risk": "none",
        "requires_approval": False,
    },
    "check_ready": {
        "function": check_ready,
        "description": "Check if the database is connected by hitting GET /ready",
        "risk": "none",
        "requires_approval": False,
    },
    "get_ecs_status": {
        "function": get_ecs_status,
        "description": "Get ECS service status: running tasks, pending tasks, recent events",
        "risk": "none",
        "requires_approval": False,
    },
    "get_recent_logs": {
        "function": get_recent_logs,
        "description": "Get recent application logs from CloudWatch. Can filter by pattern.",
        "risk": "none",
        "requires_approval": False,
    },
    "get_rds_status": {
        "function": get_rds_status,
        "description": "Get database instance status (running, storage, engine version)",
        "risk": "none",
        "requires_approval": False,
    },
    "get_alb_health": {
        "function": get_alb_health,
        "description": "Check target group health — are ECS tasks healthy from the load balancer's perspective",
        "risk": "none",
        "requires_approval": False,
    },
    "get_cpu_memory_metrics": {
        "function": get_cpu_memory_metrics,
        "description": "Get CPU and memory utilization for the ECS service (last 15 minutes)",
        "risk": "none",
        "requires_approval": False,
    },
    # Remediation (requires guardrails)
    "restart_service": {
        "function": restart_service,
        "description": "Force a new deployment — restarts all tasks with rolling update (no downtime)",
        "risk": "low",
        "requires_approval": True,
    },
    "scale_service": {
        "function": scale_service,
        "description": "Scale the ECS service to a specific number of tasks (1-10)",
        "risk": "medium",
        "requires_approval": True,
    },
    # Communication
    "notify_slack": {
        "function": notify_slack,
        "description": "Send a notification to Slack with severity level",
        "risk": "none",
        "requires_approval": False,
    },
}
