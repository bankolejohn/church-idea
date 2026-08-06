"""
Configuration for the AI SRE Agent.

Loads settings from environment variables.
Never hardcode secrets — always use .env or environment.
"""

import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # Claude API
    ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
    MODEL = "claude-sonnet-4-20250514"  # Fast + capable

    # AWS
    AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
    ECS_CLUSTER = os.getenv("ECS_CLUSTER", "church-cms-prod-cluster")
    ECS_SERVICE = os.getenv("ECS_SERVICE", "church-cms-prod-service")
    RDS_INSTANCE = os.getenv("RDS_INSTANCE", "church-cms-prod-db")
    ALB_NAME = os.getenv("ALB_NAME", "church-cms-prod-alb")
    LOG_GROUP = os.getenv("LOG_GROUP", "/ecs/church-cms-prod")

    # Application
    APP_URL = os.getenv("APP_URL", "https://app.johndesiventures.website")
    APP_NAME = os.getenv("APP_NAME", "church-cms")

    # Slack
    SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")

    # Agent Behavior
    AUTO_FIX_ENABLED = os.getenv("AUTO_FIX_ENABLED", "true").lower() == "true"
    REQUIRE_HUMAN_APPROVAL = os.getenv("REQUIRE_HUMAN_APPROVAL", "true").lower() == "true"
    MAX_RETRIES = int(os.getenv("MAX_RETRIES", "3"))
