"""
AI SRE Agent — OpenAI Version (GPT-4o / GPT-4o-mini)

Same architecture as agent.py (Claude version) but uses OpenAI's API.
Demonstrates that the agent pattern is LLM-agnostic — swap the brain, keep the hands.

Run: python agent_openai.py "ServiceDown alert fired. Health check failing."
"""

import json
import time
import os
from datetime import datetime
from openai import OpenAI
from dotenv import load_dotenv
from tools import TOOLS
from rich.console import Console
from rich.panel import Panel
from rich.markdown import Markdown

load_dotenv()
console = Console()

# ─── Configuration ────────────────────────────────────────────────
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
APP_URL = os.getenv("APP_URL", "https://app.johndesiventures.website")
ECS_CLUSTER = os.getenv("ECS_CLUSTER", "church-cms-prod-cluster")
ECS_SERVICE = os.getenv("ECS_SERVICE", "church-cms-prod-service")
RDS_INSTANCE = os.getenv("RDS_INSTANCE", "church-cms-prod-db")
LOG_GROUP = os.getenv("LOG_GROUP", "/ecs/church-cms-prod")
REQUIRE_HUMAN_APPROVAL = os.getenv("REQUIRE_HUMAN_APPROVAL", "true").lower() == "true"

# ─── System Prompt ────────────────────────────────────────────────
SYSTEM_PROMPT = f"""You are an AI SRE Agent responsible for monitoring, diagnosing, and resolving production incidents for a Node.js application (church-cms) running on AWS ECS Fargate.

## Your Approach (ALWAYS follow this order)
1. OBSERVE: Check health endpoints, ECS status, and recent logs
2. DIAGNOSE: Identify the root cause by analyzing the observations
3. DECIDE: Can this be auto-fixed safely? Or does it need human intervention?
4. ACT: Apply the fix if it's safe (restart service, scale up)
5. VERIFY: Confirm the fix worked (re-check health, ready, logs)
6. REPORT: Generate a clear summary with root cause, actions taken, and status

## Guardrails (NEVER violate these)
- NEVER delete data, databases, or storage
- NEVER modify security groups or IAM policies
- NEVER scale to 0 (causes complete outage)
- NEVER apply a fix more than 3 times
- ALWAYS verify after applying a fix
- If unsure, ESCALATE to human

## Environment
- App URL: {APP_URL}
- ECS Cluster: {ECS_CLUSTER}
- ECS Service: {ECS_SERVICE}
- RDS Instance: {RDS_INSTANCE}
- Log Group: {LOG_GROUP}

## Output Format
Be concise. Use structured format: Status / Root Cause / Action Taken / Verification / Recommendation.
"""

# ─── Tool Definitions (OpenAI format) ─────────────────────────────
OPENAI_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "check_health",
            "description": "Check if the application is alive by hitting GET /health. Returns status, http_code, and response.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_ready",
            "description": "Check if the database is connected by hitting GET /ready.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_ecs_status",
            "description": "Get ECS service status: desired count, running count, pending count, recent events.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_recent_logs",
            "description": "Get recent application logs from CloudWatch. Can filter by pattern.",
            "parameters": {
                "type": "object",
                "properties": {
                    "minutes": {"type": "integer", "description": "Minutes of logs to retrieve (default 10)"},
                    "filter_pattern": {"type": "string", "description": "Filter pattern (e.g., 'error', 'Failed login')"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_rds_status",
            "description": "Get database instance status.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_alb_health",
            "description": "Check target group health — are ECS tasks healthy from ALB perspective.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_cpu_memory_metrics",
            "description": "Get CPU and memory utilization for ECS service (last 15 minutes).",
            "parameters": {
                "type": "object",
                "properties": {
                    "minutes": {"type": "integer", "description": "Minutes of history (default 15)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "restart_service",
            "description": "Force new ECS deployment — restarts all tasks with rolling update. No downtime.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scale_service",
            "description": "Scale ECS service to specific task count (1-10).",
            "parameters": {
                "type": "object",
                "properties": {
                    "desired_count": {"type": "integer", "description": "Number of tasks (1-10)"},
                },
                "required": ["desired_count"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "notify_slack",
            "description": "Send notification to Slack.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "Message to send"},
                    "severity": {"type": "string", "enum": ["critical", "warning", "info", "resolved"]},
                },
                "required": ["message", "severity"],
            },
        },
    },
]


# ─── Agent Class ──────────────────────────────────────────────────

class SREAgentOpenAI:
    """AI SRE Agent powered by OpenAI GPT-4o."""

    def __init__(self):
        self.client = OpenAI(api_key=OPENAI_API_KEY)
        self.messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        self.actions_taken = []
        self.start_time = None

    def run(self, alert_description: str) -> dict:
        """Main entry point — give it an alert, it investigates and resolves."""
        self.start_time = time.time()
        console.print(Panel(f"[bold red]ALERT:[/bold red] {alert_description}", title="SRE Agent Activated"))
        console.print(f"[dim]Model: {MODEL} | Provider: OpenAI[/dim]\n")

        self.messages.append({"role": "user", "content": f"ALERT: {alert_description}\n\nInvestigate and resolve. Follow: OBSERVE → DIAGNOSE → ACT → VERIFY → REPORT."})

        max_iterations = 20
        iteration = 0

        while iteration < max_iterations:
            iteration += 1
            console.print(f"[dim]── Agent thinking (iteration {iteration}) ──[/dim]")

            response = self.client.chat.completions.create(
                model=MODEL,
                messages=self.messages,
                tools=OPENAI_TOOLS,
                tool_choice="auto",
            )

            message = response.choices[0].message

            # Check if the model wants to call tools
            if message.tool_calls:
                self.messages.append(message)
                self._handle_tool_calls(message.tool_calls)
            else:
                # Model is done — final response
                final_text = message.content or ""
                console.print(Panel(Markdown(final_text), title="Agent Report", border_style="green"))

                duration = round(time.time() - self.start_time, 1)
                return {
                    "status": "resolved" if "resolved" in final_text.lower() else "escalated",
                    "actions_taken": self.actions_taken,
                    "report": final_text,
                    "duration_seconds": duration,
                    "iterations": iteration,
                }

        return {
            "status": "max_iterations",
            "actions_taken": self.actions_taken,
            "report": "Max iterations reached. Escalating.",
            "duration_seconds": round(time.time() - self.start_time, 1),
        }

    def _handle_tool_calls(self, tool_calls):
        """Execute tool calls and return results to the model."""
        for tool_call in tool_calls:
            tool_name = tool_call.function.name
            try:
                tool_args = json.loads(tool_call.function.arguments) if tool_call.function.arguments else {}
            except json.JSONDecodeError:
                tool_args = {}

            console.print(f"  [cyan]→ Calling:[/cyan] {tool_name}({json.dumps(tool_args) if tool_args else ''})")

            # Execute with guardrails
            result = self._execute_tool(tool_name, tool_args)
            result_str = json.dumps(result)

            console.print(f"  [green]← Result:[/green] {result_str[:200]}{'...' if len(result_str) > 200 else ''}")

            # Add result to conversation
            self.messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result_str,
            })

            self.actions_taken.append({
                "tool": tool_name,
                "args": tool_args,
                "result": result,
                "timestamp": datetime.utcnow().isoformat(),
            })

    def _execute_tool(self, tool_name: str, tool_args: dict) -> dict:
        """Execute a tool with guardrails."""
        tool_info = TOOLS.get(tool_name)
        if not tool_info:
            return {"error": f"Unknown tool: {tool_name}"}

        # Human approval for risky actions
        if tool_info["requires_approval"] and REQUIRE_HUMAN_APPROVAL:
            console.print(f"  [yellow]⚠ APPROVAL REQUIRED:[/yellow] {tool_name} (risk: {tool_info['risk']})")
            approval = input(f"  Allow {tool_name}? [y/N]: ").strip().lower()
            if approval != "y":
                return {"blocked": True, "reason": "Human denied approval"}

        try:
            if tool_args:
                return tool_info["function"](**tool_args)
            else:
                return tool_info["function"]()
        except Exception as e:
            return {"error": str(e)}


# ─── Main ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    if not OPENAI_API_KEY:
        console.print("[red]ERROR: OPENAI_API_KEY not set in .env[/red]")
        sys.exit(1)

    if len(sys.argv) > 1:
        alert = " ".join(sys.argv[1:])
    else:
        alert = "ServiceDown alert fired. Application health check is failing. Users report the app is unreachable."

    agent = SREAgentOpenAI()
    result = agent.run(alert)

    console.print(f"\n[bold]Status:[/bold] {result['status']}")
    console.print(f"[bold]Duration:[/bold] {result['duration_seconds']}s")
    console.print(f"[bold]Actions:[/bold] {len(result['actions_taken'])}")
