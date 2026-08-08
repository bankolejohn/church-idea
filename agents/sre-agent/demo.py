"""
AI SRE Agent — Demo Mode (No API Key Required)

This demonstrates the EXACT same flow as the real agent, but uses
scripted reasoning instead of Claude API calls. Perfect for:
- Learning how the agent works
- Presentations and interviews
- Testing without spending money
- Understanding the observe → diagnose → act → verify cycle

Run: python demo.py
"""

import time
import json
from datetime import datetime
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.markdown import Markdown
from rich import box

console = Console()


# ─── Simulated Tool Results ───────────────────────────────────────
# These simulate what the REAL tools would return

MOCK_SCENARIOS = {
    "service_down": {
        "description": "ServiceDown alert fired. Application health check is failing. Users report the app is unreachable.",
        "steps": [
            {
                "thought": "Let me check if the application is actually responding to health checks.",
                "tool": "check_health",
                "args": {},
                "result": {"status": "unreachable", "http_code": 0, "response": "Connection refused"},
            },
            {
                "thought": "Health check is failing. Let me check the ECS service — are tasks even running?",
                "tool": "get_ecs_status",
                "args": {},
                "result": {
                    "desired_count": 2,
                    "running_count": 0,
                    "pending_count": 1,
                    "status": "ACTIVE",
                    "deployments": 1,
                    "events": [
                        {"time": "2026-06-30T12:05:30", "message": "(service church-cms-prod-service) has started 1 tasks: (task abc123)."},
                        {"time": "2026-06-30T12:05:00", "message": "(service church-cms-prod-service) was unable to place a task because no container instance met all requirements."},
                        {"time": "2026-06-30T12:04:30", "message": "(service church-cms-prod-service) stopped 2 tasks: Essential container exited."},
                    ],
                },
            },
            {
                "thought": "Zero running tasks! Tasks are crashing. Let me check the logs to see WHY they're exiting.",
                "tool": "get_recent_logs",
                "args": {"minutes": 10, "filter_pattern": "error"},
                "result": {
                    "log_count": 3,
                    "logs": [
                        {"timestamp": "2026-06-30 12:04:28", "message": "error: FATAL: password authentication failed for user \"churchadmin\""},
                        {"timestamp": "2026-06-30 12:04:28", "message": "error: Database health check failed: Connection terminated due to authentication failure"},
                        {"timestamp": "2026-06-30 12:04:29", "message": "error: Graceful shutdown complete (database connection failed on startup)"},
                    ],
                },
            },
            {
                "thought": "Root cause identified: Database authentication failure. The password in Secrets Manager may have been rotated without updating the app. Let me check RDS status to confirm the database itself is healthy.",
                "tool": "get_rds_status",
                "args": {},
                "result": {
                    "status": "available",
                    "multi_az": True,
                    "publicly_accessible": False,
                    "storage_allocated_gb": 50,
                    "engine": "postgres 16.4",
                },
            },
            {
                "thought": "Database is healthy (available). The issue is authentication — the app has wrong credentials. A service restart will re-read secrets from Secrets Manager. If the secret was recently updated, the new password will be picked up.",
                "tool": "restart_service",
                "args": {},
                "result": {
                    "action": "restart_service",
                    "result": "success",
                    "message": "Forced new deployment for church-cms-prod-service",
                    "desired_count": 2,
                },
                "requires_approval": True,
            },
            {
                "thought": "Service restart initiated. Waiting 60 seconds for new tasks to start and register with the ALB...",
                "tool": "WAIT",
                "args": {"seconds": 60},
                "result": {"waited": "60 seconds"},
            },
            {
                "thought": "Let me verify the application has recovered.",
                "tool": "check_health",
                "args": {},
                "result": {"status": "healthy", "http_code": 200, "response": {"status": "ok", "timestamp": "2026-06-30T12:06:35.123Z", "uptime": 12.5}},
            },
            {
                "thought": "Application is healthy again! Let me also verify database connectivity.",
                "tool": "check_ready",
                "args": {},
                "result": {"status": "ready", "http_code": 200, "response": {"status": "ready", "database": "connected"}},
            },
        ],
        "rca": """## Incident Resolution Report

**Alert:** ServiceDown
**Duration:** ~2 minutes
**Root Cause:** Database authentication failure — tasks crashed on startup because the DATABASE_URL credential in Secrets Manager was stale or recently rotated.

**Timeline:**
- 12:04:30 — Tasks exited with "password authentication failed"
- 12:05:00 — ECS attempted to restart but 0 tasks running
- 12:05:45 — Agent detected via health check failure
- 12:06:00 — Agent initiated service restart (re-reads secrets)
- 12:06:35 — Application healthy, database connected

**Fix Applied:** Forced new deployment — ECS tasks re-read Secrets Manager on startup and authenticated successfully.

**Status:** RESOLVED

**Permanent Fix Needed:**
- [ ] Investigate why the credential changed (secret rotation? manual update?)
- [ ] Ensure ECS task execution role has latest secret version access
- [ ] Add a pre-deployment check for secret validity
""",
    },

    "high_latency": {
        "description": "HighLatency alert fired. p95 response time is 4.2 seconds. Users reporting slow page loads.",
        "steps": [
            {
                "thought": "Let me check the current health and response time.",
                "tool": "check_health",
                "args": {},
                "result": {"status": "healthy", "http_code": 200, "response": {"status": "ok", "timestamp": "2026-06-30T14:30:00Z", "uptime": 8640.5}},
            },
            {
                "thought": "App is alive but slow. Let me check CPU and memory — is it resource-bound?",
                "tool": "get_cpu_memory_metrics",
                "args": {"minutes": 15},
                "result": {
                    "cpu": {"current_avg": 78.5, "current_max": 92.3},
                    "memory": {"current_avg": 45.2, "current_max": 52.1},
                },
            },
            {
                "thought": "CPU is at 78% average and 92% max — that's high! Memory is fine. This is a CPU-bound issue. Let me check how many tasks are running.",
                "tool": "get_ecs_status",
                "args": {},
                "result": {
                    "desired_count": 2,
                    "running_count": 2,
                    "pending_count": 0,
                    "status": "ACTIVE",
                    "deployments": 1,
                    "events": [
                        {"time": "2026-06-30T14:25:00", "message": "(service church-cms-prod-service) has reached a steady state."},
                    ],
                },
            },
            {
                "thought": "Only 2 tasks running with high CPU. I should scale up to distribute the load. Scaling to 4 tasks should halve the CPU per task.",
                "tool": "scale_service",
                "args": {"desired_count": 4},
                "result": {
                    "action": "scale_service",
                    "result": "success",
                    "message": "Scaled church-cms-prod-service to 4 tasks",
                    "previous_count": 2,
                    "new_desired": 4,
                },
                "requires_approval": True,
            },
            {
                "thought": "Scaled to 4 tasks. Waiting 120 seconds for new tasks to start, register with ALB, and for load to redistribute...",
                "tool": "WAIT",
                "args": {"seconds": 120},
                "result": {"waited": "120 seconds"},
            },
            {
                "thought": "Let me verify CPU has dropped and latency has improved.",
                "tool": "get_cpu_memory_metrics",
                "args": {"minutes": 5},
                "result": {
                    "cpu": {"current_avg": 38.2, "current_max": 45.1},
                    "memory": {"current_avg": 42.8, "current_max": 48.3},
                },
            },
        ],
        "rca": """## Incident Resolution Report

**Alert:** HighLatency (p95 > 2s)
**Duration:** ~3 minutes
**Root Cause:** CPU saturation — 2 tasks handling a traffic spike, causing request queuing and elevated latency.

**Evidence:**
- CPU: 78% avg, 92% max (before fix)
- CPU: 38% avg, 45% max (after scaling to 4 tasks)
- Memory was fine (45%) — not a memory issue

**Fix Applied:** Scaled ECS service from 2 → 4 tasks. CPU dropped by 50%, latency returned to normal.

**Status:** RESOLVED

**Permanent Fix Needed:**
- [ ] Review auto-scaling thresholds (current: scale at 70% CPU — should it be lower?)
- [ ] Investigate what caused the traffic spike (marketing campaign? bot traffic?)
- [ ] Consider increasing base task count from 2 to 3 for this time of day
""",
    },
}


# ─── Demo Runner ──────────────────────────────────────────────────

def run_demo(scenario_name: str = "service_down"):
    """Run a simulated agent investigation."""

    scenario = MOCK_SCENARIOS.get(scenario_name)
    if not scenario:
        console.print(f"[red]Unknown scenario: {scenario_name}[/red]")
        console.print(f"Available: {', '.join(MOCK_SCENARIOS.keys())}")
        return

    # Header
    console.print("\n")
    console.print(Panel(
        "[bold]AI SRE Agent — Demo Mode[/bold]\n"
        "[dim]Simulating autonomous incident response (no API key required)[/dim]",
        border_style="blue",
    ))

    # Alert
    console.print(Panel(
        f"[bold red]ALERT:[/bold red] {scenario['description']}",
        title="Incident Detected",
        border_style="red",
    ))

    time.sleep(1)

    # Process each step
    actions_taken = []
    for i, step in enumerate(scenario["steps"], 1):
        console.print(f"\n[dim]── Agent thinking (step {i}/{len(scenario['steps'])}) ──[/dim]")
        time.sleep(0.5)

        # Show thought
        console.print(f"  [bold cyan]🤔 Reasoning:[/bold cyan] {step['thought']}")
        time.sleep(0.8)

        # Show tool call
        if step["tool"] == "WAIT":
            console.print(f"  [yellow]⏳ Waiting {step['args']['seconds']} seconds...[/yellow]")
            time.sleep(2)  # Simulate shorter wait
            continue

        args_str = json.dumps(step["args"]) if step["args"] else ""
        console.print(f"  [cyan]→ Calling:[/cyan] {step['tool']}({args_str})")
        time.sleep(0.5)

        # Check for approval
        if step.get("requires_approval"):
            console.print(f"  [yellow]⚠ APPROVAL REQUIRED:[/yellow] {step['tool']} (remediation action)")
            approval = input(f"  Allow {step['tool']}? [y/N]: ").strip().lower()
            if approval != "y":
                console.print(f"  [red]✗ Blocked by human. Escalating...[/red]")
                return
            console.print(f"  [green]✓ Approved[/green]")

        # Show result
        result_str = json.dumps(step["result"], indent=2)
        if len(result_str) > 200:
            result_str = result_str[:200] + "..."
        console.print(f"  [green]← Result:[/green] {result_str}")
        time.sleep(0.5)

        actions_taken.append(step["tool"])

    # Show RCA
    console.print("\n")
    console.print(Panel(
        Markdown(scenario["rca"]),
        title="Agent Report (Root Cause Analysis)",
        border_style="green",
    ))

    # Summary
    console.print("\n")
    summary = Table(title="Incident Summary", box=box.ROUNDED)
    summary.add_column("Metric", style="bold")
    summary.add_column("Value")
    summary.add_row("Status", "[green]RESOLVED[/green]")
    summary.add_row("Actions Taken", str(len(actions_taken)))
    summary.add_row("Tools Used", ", ".join(actions_taken))
    summary.add_row("Human Approvals", "1 (remediation action)")
    summary.add_row("Auto-Diagnosed", "Yes")
    summary.add_row("Demo Mode", "Yes (no API key used)")
    console.print(summary)

    console.print("\n[dim]This is exactly how the real agent works — same flow, same tools,")
    console.print("same guardrails. The only difference: Claude provides the reasoning instead of scripts.[/dim]\n")


# ─── Main ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    console.print("\n[bold]Available demo scenarios:[/bold]")
    console.print("  1. service_down  — App unreachable, tasks crashing (DB auth failure)")
    console.print("  2. high_latency  — Slow responses due to CPU saturation")
    console.print()

    if len(sys.argv) > 1:
        scenario = sys.argv[1]
    else:
        choice = input("Choose scenario [1/2]: ").strip()
        scenario = "high_latency" if choice == "2" else "service_down"

    run_demo(scenario)
