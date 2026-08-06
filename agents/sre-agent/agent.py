"""
AI SRE Agent — The Brain.

This is the core agent loop:
  OBSERVE → THINK → ACT → VERIFY → REPORT

The agent uses Claude to:
1. Understand what alert/issue occurred
2. Decide what diagnostic steps to run
3. Analyze the results
4. Decide on a fix (or escalate to human)
5. Apply the fix (if safe)
6. Verify recovery
7. Generate an RCA (Root Cause Analysis)

HOW IT WORKS (simplified):
- We send Claude a system prompt (its "personality" and rules)
- We give it a list of TOOLS it can call (functions defined in tools.py)
- We describe the problem
- Claude responds with either:
  a) A tool_use request ("I want to call check_health")
  b) A text response ("The issue is resolved. Here's the RCA.")
- We execute the tool and send the result back
- Claude continues reasoning until it's done

This is the "agent loop" — the LLM thinks, acts, observes the result,
and thinks again until the problem is solved or it needs a human.
"""

import json
import time
from datetime import datetime
from anthropic import Anthropic
from config import Config
from tools import TOOLS
from rich.console import Console
from rich.panel import Panel
from rich.markdown import Markdown

console = Console()

# ─── System Prompt (The Agent's Personality & Rules) ──────────────
SYSTEM_PROMPT = """You are an AI SRE Agent responsible for monitoring, diagnosing, and resolving production incidents for a Node.js application (church-cms) running on AWS ECS Fargate.

## Your Role
You are the FIRST RESPONDER when an issue is detected. You diagnose systematically, fix what you can safely, and escalate what you can't.

## Your Approach (ALWAYS follow this order)
1. OBSERVE: Check health endpoints, ECS status, and recent logs
2. DIAGNOSE: Identify the root cause by analyzing the observations
3. DECIDE: Can this be auto-fixed safely? Or does it need human intervention?
4. ACT: Apply the fix if it's safe (restart service, scale up)
5. VERIFY: Confirm the fix worked (re-check health, ready, logs)
6. REPORT: Generate a clear summary of what happened, what you did, and whether it's resolved

## Guardrails (NEVER violate these)
- NEVER delete data, databases, or storage
- NEVER modify security groups or IAM policies
- NEVER scale to 0 (causes complete outage)
- NEVER apply a fix more than 3 times (escalate instead)
- ALWAYS verify after applying a fix
- If unsure, ASK the human — don't guess

## Available Information
- App URL: {app_url}
- ECS Cluster: {ecs_cluster}
- ECS Service: {ecs_service}
- RDS Instance: {rds_instance}
- Log Group: {log_group}

## Communication Style
- Be concise and precise
- Use structured format (Status/Cause/Action/Result)
- Include specific evidence (log lines, metrics, status codes)
- When escalating, explain WHY you can't auto-fix
""".format(
    app_url=Config.APP_URL,
    ecs_cluster=Config.ECS_CLUSTER,
    ecs_service=Config.ECS_SERVICE,
    rds_instance=Config.RDS_INSTANCE,
    log_group=Config.LOG_GROUP,
)

# ─── Tool Definitions (What Claude Sees) ─────────────────────────
# These tell Claude what tools are available and how to call them
CLAUDE_TOOLS = [
    {
        "name": "check_health",
        "description": "Check if the application is alive by hitting GET /health. Returns status, http_code, and response body.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "check_ready",
        "description": "Check if the database is connected by hitting GET /ready. Returns status, http_code, and response body.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_ecs_status",
        "description": "Get ECS service status: desired count, running count, pending count, recent events.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_recent_logs",
        "description": "Get recent application logs from CloudWatch. Can filter by pattern.",
        "input_schema": {
            "type": "object",
            "properties": {
                "minutes": {"type": "integer", "description": "How many minutes of logs to retrieve (default 10)"},
                "filter_pattern": {"type": "string", "description": "Filter pattern (e.g., 'error', 'Failed login')"},
            },
            "required": [],
        },
    },
    {
        "name": "get_rds_status",
        "description": "Get database instance status (available, rebooting, failed, etc.)",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_alb_health",
        "description": "Check target group health — are ECS tasks healthy from the load balancer's perspective.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_cpu_memory_metrics",
        "description": "Get CPU and memory utilization for the ECS service (last 15 minutes).",
        "input_schema": {
            "type": "object",
            "properties": {
                "minutes": {"type": "integer", "description": "Minutes of history (default 15)"},
            },
            "required": [],
        },
    },
    {
        "name": "restart_service",
        "description": "Force a new deployment — restarts all tasks with rolling update. Low risk, no downtime. Use when tasks are stuck or need a fresh start.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "scale_service",
        "description": "Scale the ECS service to a specific number of tasks (1-10). Use to handle traffic spikes or recover from capacity issues.",
        "input_schema": {
            "type": "object",
            "properties": {
                "desired_count": {"type": "integer", "description": "Number of tasks to run (1-10)"},
            },
            "required": ["desired_count"],
        },
    },
    {
        "name": "notify_slack",
        "description": "Send a notification to Slack. Use for status updates and RCA reports.",
        "input_schema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Message to send"},
                "severity": {"type": "string", "enum": ["critical", "warning", "info", "resolved"], "description": "Alert severity"},
            },
            "required": ["message", "severity"],
        },
    },
]


# ─── The Agent Class ──────────────────────────────────────────────

class SREAgent:
    """The AI SRE Agent — observes, diagnoses, and resolves production issues."""

    def __init__(self):
        self.client = Anthropic(api_key=Config.ANTHROPIC_API_KEY)
        self.conversation = []
        self.actions_taken = []
        self.start_time = None

    def run(self, alert_description: str) -> dict:
        """
        Main entry point. Give the agent an alert/issue description
        and it will diagnose and attempt to resolve it.

        Returns a dict with: status, actions_taken, rca, duration
        """
        self.start_time = time.time()
        console.print(Panel(f"[bold red]ALERT:[/bold red] {alert_description}", title="SRE Agent Activated"))

        # Start the conversation with the alert
        self.conversation = [
            {"role": "user", "content": f"ALERT RECEIVED: {alert_description}\n\nPlease investigate this issue. Follow your diagnostic procedure: OBSERVE → DIAGNOSE → DECIDE → ACT → VERIFY → REPORT."}
        ]

        # The agent loop — keep going until Claude gives a final answer (no more tool calls)
        max_iterations = 20  # Safety limit
        iteration = 0

        while iteration < max_iterations:
            iteration += 1
            console.print(f"\n[dim]── Agent thinking (iteration {iteration}) ──[/dim]")

            # Call Claude
            response = self.client.messages.create(
                model=Config.MODEL,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=CLAUDE_TOOLS,
                messages=self.conversation,
            )

            # Process the response
            if response.stop_reason == "tool_use":
                # Claude wants to use a tool
                self._handle_tool_use(response)
            elif response.stop_reason == "end_turn":
                # Claude is done — extract final message
                final_text = ""
                for block in response.content:
                    if hasattr(block, "text"):
                        final_text += block.text

                console.print(Panel(Markdown(final_text), title="Agent Report", border_style="green"))

                duration = round(time.time() - self.start_time, 1)
                return {
                    "status": "resolved" if "resolved" in final_text.lower() else "escalated",
                    "actions_taken": self.actions_taken,
                    "report": final_text,
                    "duration_seconds": duration,
                    "iterations": iteration,
                }
            else:
                console.print(f"[yellow]Unexpected stop reason: {response.stop_reason}[/yellow]")
                break

        return {
            "status": "max_iterations_reached",
            "actions_taken": self.actions_taken,
            "report": "Agent reached maximum iterations without resolution. Escalating to human.",
            "duration_seconds": round(time.time() - self.start_time, 1),
            "iterations": iteration,
        }

    def _handle_tool_use(self, response):
        """Process tool use requests from Claude."""
        # Add Claude's response to conversation
        self.conversation.append({"role": "assistant", "content": response.content})

        # Process each tool call
        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                tool_name = block.name
                tool_input = block.input

                console.print(f"  [cyan]→ Calling:[/cyan] {tool_name}({json.dumps(tool_input) if tool_input else ''})")

                # Execute the tool
                result = self._execute_tool(tool_name, tool_input)

                console.print(f"  [green]← Result:[/green] {json.dumps(result)[:200]}...")

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result),
                })

                # Track action
                self.actions_taken.append({
                    "tool": tool_name,
                    "input": tool_input,
                    "result": result,
                    "timestamp": datetime.utcnow().isoformat(),
                })

        # Send tool results back to Claude
        self.conversation.append({"role": "user", "content": tool_results})

    def _execute_tool(self, tool_name: str, tool_input: dict) -> dict:
        """Execute a tool and apply guardrails."""
        tool_info = TOOLS.get(tool_name)
        if not tool_info:
            return {"error": f"Unknown tool: {tool_name}"}

        # Check guardrails
        if tool_info["requires_approval"] and Config.REQUIRE_HUMAN_APPROVAL:
            console.print(f"  [yellow]⚠ APPROVAL REQUIRED:[/yellow] {tool_name} (risk: {tool_info['risk']})")
            approval = input(f"  Allow {tool_name}? [y/N]: ").strip().lower()
            if approval != "y":
                return {"blocked": True, "reason": "Human denied approval"}

        # Execute
        try:
            if tool_input:
                return tool_info["function"](**tool_input)
            else:
                return tool_info["function"]()
        except Exception as e:
            return {"error": f"Tool execution failed: {str(e)}"}


# ─── Main Entry Point ─────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    if not Config.ANTHROPIC_API_KEY:
        console.print("[red]ERROR: ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.[/red]")
        sys.exit(1)

    # Example: simulate an alert
    if len(sys.argv) > 1:
        alert = " ".join(sys.argv[1:])
    else:
        alert = "ServiceDown alert fired. The application health check is failing. Users report the app is unreachable."

    agent = SREAgent()
    result = agent.run(alert)

    console.print(f"\n[bold]Resolution:[/bold] {result['status']}")
    console.print(f"[bold]Duration:[/bold] {result['duration_seconds']}s")
    console.print(f"[bold]Actions taken:[/bold] {len(result['actions_taken'])}")
