# AI SRE Agent

An autonomous agent that monitors, diagnoses, and resolves production incidents — with human-in-the-loop guardrails.

## What It Does

```
Alert fires → Agent observes → Diagnoses root cause → Applies safe fix → Verifies → Reports
```

The agent uses Claude as its reasoning engine and AWS SDK as its hands. It follows structured runbooks but can reason about novel situations.

## Quick Start

```bash
cd agents/sre-agent

# Install dependencies
pip install -r requirements.txt

# Configure
cp .env.example .env
# Edit .env — add your ANTHROPIC_API_KEY

# Run with a simulated alert
python agent.py "ServiceDown alert fired. Health check is failing."

# Run with a custom alert
python agent.py "High latency detected. p95 response time is 4 seconds."
```

## How It Works

### The Agent Loop

```
1. Receive alert description
2. Claude reads the alert + system prompt (its rules)
3. Claude decides: "I should check health first" → calls check_health tool
4. Agent executes the tool, returns result to Claude
5. Claude analyzes: "Health is failing. Let me check ECS status."
6. → calls get_ecs_status
7. Claude: "0 running tasks. I should restart the service."
8. → calls restart_service (asks for human approval first)
9. Human approves → agent executes restart
10. Claude: "Let me verify recovery" → calls check_health again
11. Claude: "Health is restored. Here's my RCA report."
12. → calls notify_slack with the summary
```

### Tools Available

| Tool | Type | Risk | Description |
|------|------|------|-------------|
| `check_health` | Diagnostic | None | GET /health |
| `check_ready` | Diagnostic | None | GET /ready (database check) |
| `get_ecs_status` | Diagnostic | None | ECS service status |
| `get_recent_logs` | Diagnostic | None | CloudWatch logs |
| `get_rds_status` | Diagnostic | None | Database status |
| `get_alb_health` | Diagnostic | None | Target group health |
| `get_cpu_memory_metrics` | Diagnostic | None | CPU/Memory metrics |
| `restart_service` | Remediation | Low | Force new ECS deployment |
| `scale_service` | Remediation | Medium | Scale tasks up/down |
| `notify_slack` | Communication | None | Send Slack message |

### Guardrails

The agent CANNOT:
- Delete data, databases, or storage
- Modify security groups or IAM policies
- Scale to 0 (would cause outage)
- Apply the same fix more than 3 times
- Execute destructive actions without human approval

### Runbooks

The `runbooks/` directory contains YAML-structured procedures:
- `service_down.yaml` — Complete outage handling
- `high_error_rate.yaml` — 5xx error spike handling
- `high_latency.yaml` — Slow response handling

These serve as the agent's knowledge base — structured procedures it can follow while also applying reasoning to novel situations.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              AI SRE Agent                        │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Claude API (reasoning engine)            │   │
│  │  - Reads alert context                    │   │
│  │  - Decides next action                    │   │
│  │  - Analyzes tool results                  │   │
│  │  - Generates RCA                          │   │
│  └────────────────┬─────────────────────────┘   │
│                   │                              │
│  ┌────────────────▼─────────────────────────┐   │
│  │  Tool Registry (agent's hands)            │   │
│  │  - Diagnostic: read-only AWS calls        │   │
│  │  - Remediation: restart, scale (guarded)  │   │
│  │  - Communication: Slack notifications     │   │
│  └────────────────┬─────────────────────────┘   │
│                   │                              │
│  ┌────────────────▼─────────────────────────┐   │
│  │  Guardrails                               │   │
│  │  - Human approval for risky actions       │   │
│  │  - Hard limits (never scale to 0)         │   │
│  │  - Max retry count (3)                    │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
┌─────────────────┐    ┌──────────────────┐
│  AWS (boto3)    │    │  Slack Webhook   │
│  - ECS          │    │  - Notifications │
│  - CloudWatch   │    │  - RCA reports   │
│  - RDS          │    └──────────────────┘
│  - ELBv2        │
└─────────────────┘
```

## For Interviews

"I built an AI SRE agent that autonomously diagnoses and resolves production incidents. It uses Claude as its reasoning engine, AWS SDK for infrastructure actions, and YAML runbooks as its knowledge base. The key design decision: diagnostic tools are always allowed (read-only), but remediation tools require human approval via a guardrail layer. This means the agent can triage and diagnose at 3am without waking anyone — but it asks before applying fixes."
