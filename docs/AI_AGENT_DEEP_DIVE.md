# AI SRE Agent — Deep Dive

Everything you need to understand about building autonomous AI agents for production operations. From concepts to implementation to interview answers.

---

## Table of Contents

1. [What is an AI Agent?](#what-is-an-ai-agent)
2. [How Our Agent Works](#how-our-agent-works)
3. [The Agent Loop (Core Pattern)](#the-agent-loop)
4. [Tool Use Explained](#tool-use-explained)
5. [Guardrails and Safety](#guardrails-and-safety)
6. [Making Agents Better Over Time](#making-agents-better-over-time)
7. [Running the Agent (Hands-On)](#running-the-agent)
8. [Architecture Decisions](#architecture-decisions)
9. [LLM Provider Comparison](#llm-provider-comparison)
10. [Real-World Agent Patterns](#real-world-agent-patterns)
11. [Key Concepts for Interviews](#key-concepts-for-interviews)

---

## What is an AI Agent?

An agent is NOT a chatbot. A chatbot answers questions. An agent DOES things.

| | Chatbot | Agent |
|---|---|---|
| Input | "What's wrong?" | "Alert: app is down" |
| Output | "Maybe check the logs" | Actually checks logs, finds error, restarts service |
| Actions | None (just text) | Calls APIs, runs commands, makes changes |
| Loop | One response | Thinks → acts → observes → thinks again |
| Autonomy | Zero | Partial to full (with guardrails) |

**The formula:**

```
Agent = LLM (brain) + Tools (hands) + Loop (persistence) + Guardrails (safety)
```

Without tools: it's a chatbot.
Without a loop: it's a one-shot function call.
Without guardrails: it's dangerous.
All four together: it's an agent.

---

## How Our Agent Works

### The Files

```
agents/sre-agent/
├── agent_openai.py   ← The brain (GPT-4o reasoning + loop)
├── agent.py          ← The brain (Claude version — same pattern)
├── tools.py          ← The hands (functions the LLM can call)
├── config.py         ← The boundaries (environment, settings)
├── demo.py           ← Demo mode (no API key needed)
├── runbooks/         ← The knowledge (structured procedures)
│   ├── service_down.yaml
│   ├── high_error_rate.yaml
│   └── high_latency.yaml
├── .env              ← Secrets (API keys — NEVER committed)
└── requirements.txt  ← Python dependencies
```

### The Flow (What Happens When an Alert Fires)

```
1. Alert arrives: "ServiceDown — health check failing"
         │
         ▼
2. Agent sends to LLM: "Here's the alert + here are your tools + here are your rules"
         │
         ▼
3. LLM responds: "I want to call check_health()"
         │
         ▼
4. Agent executes check_health() → returns {"status": "unreachable"}
         │
         ▼
5. Agent sends result back to LLM: "check_health returned unreachable"
         │
         ▼
6. LLM responds: "I want to call get_ecs_status()"
         │
         ▼
7. Agent executes get_ecs_status() → returns {"running_count": 0}
         │
         ▼
8. LLM: "Tasks crashed. I want to call restart_service()"
         │
         ▼
9. Agent checks guardrails: "This requires approval"
   → Asks human: "Allow restart_service? [y/N]"
   → Human types: y
         │
         ▼
10. Agent executes restart_service() → returns {"result": "success"}
         │
         ▼
11. LLM: "Let me verify. I want to call check_health()"
         │
         ▼
12. Agent executes → returns {"status": "healthy"}
         │
         ▼
13. LLM: "Resolved. Here's my report: ..."
         │
         ▼
14. Agent prints the report. Done.
```

**Key insight:** The LLM never touches AWS directly. It can only REQUEST tool calls. Your code DECIDES whether to execute them.

---

## The Agent Loop

This is the core pattern. Every agent (SRE, coding, support) uses this:

```python
while not done:
    # 1. Send conversation to LLM (including tool results)
    response = llm.generate(messages, tools)

    # 2. Did the LLM request a tool call?
    if response.has_tool_calls:
        for tool_call in response.tool_calls:
            # 3. Execute the tool
            result = execute_tool(tool_call.name, tool_call.args)
            # 4. Add result to conversation
            messages.append(result)
    else:
        # 5. LLM gave a final answer — we're done
        done = True
        print(response.text)
```

**That's it.** Everything else — frameworks, platforms, enterprise tools — is wrapping this pattern with more features.

### Why It's Called a "Loop"

Traditional API call:
```
Request → Response (done)
```

Agent loop:
```
Request → Tool call → Execute → Result → Tool call → Execute → Result → ... → Final answer
```

The LLM keeps going until it decides it has enough information to give a final answer. It's PERSISTENT — it doesn't stop after one action.

---

## Tool Use Explained

### What Tools Are

Tools are functions you write that the LLM can call. You describe them in a schema, and the LLM decides WHEN and HOW to call them.

### How Tools Are Defined (OpenAI Format)

```python
{
    "type": "function",
    "function": {
        "name": "check_health",
        "description": "Check if the application is alive by hitting GET /health",
        "parameters": {
            "type": "object",
            "properties": {},  # No parameters needed
            "required": []
        }
    }
}
```

The LLM reads the `name` and `description` to decide when to use it. Good descriptions = better tool selection.

### How Tools Are Executed

```python
# In tools.py — the actual function:
def check_health() -> dict:
    response = requests.get("https://app.example.com/health", timeout=10)
    return {"status": "healthy" if response.status_code == 200 else "unhealthy"}
```

The LLM says "call check_health" → your code runs this function → returns the result → LLM sees the result and decides next action.

### Tool Categories (Our Agent)

| Category | Examples | Risk | Approval Needed? |
|----------|---------|------|-----------------|
| **Diagnostic** | check_health, get_logs, get_metrics | None (read-only) | No |
| **Remediation** | restart_service, scale_service | Low-Medium | Yes |
| **Communication** | notify_slack | None | No |
| **Destructive** | (not implemented) | High | ALWAYS |

### Adding New Tools

To make the agent more capable, add a function:

```python
# 1. Write the function
def check_ssl_expiry() -> dict:
    """Check SSL certificate expiration."""
    # ... implementation ...
    return {"days_remaining": 45}

# 2. Register it in TOOLS dict
TOOLS["check_ssl_expiry"] = {
    "function": check_ssl_expiry,
    "description": "Check SSL certificate expiration",
    "risk": "none",
    "requires_approval": False,
}

# 3. Add to OPENAI_TOOLS (so the LLM knows about it)
OPENAI_TOOLS.append({
    "type": "function",
    "function": {
        "name": "check_ssl_expiry",
        "description": "Check if SSL certificate is expiring soon",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
})
```

Now the agent can check SSL certs. No model retraining needed.

---

## Guardrails and Safety

### The 6 Layers of Protection

| Layer | What | Controls |
|-------|------|----------|
| 1. IAM Role | What AWS APIs the agent can call | Infrastructure |
| 2. Code Limits | Hard limits in tool functions (min 1, max 10 tasks) | Code |
| 3. Human Approval | Agent asks before risky actions | Runtime |
| 4. Tool Registry | Only pre-defined functions exist | Design |
| 5. Audit Trail | Every action logged with timestamp | Post-hoc |
| 6. Environment Config | Mode switches (read-only, supervised, autonomous) | Configuration |

### How Human-in-the-Loop Works

```python
if tool_info["requires_approval"] and REQUIRE_HUMAN_APPROVAL:
    approval = input(f"Allow {tool_name}? [y/N]: ")
    if approval != "y":
        return {"blocked": True, "reason": "Human denied"}
```

The agent STOPS. Explains what it wants to do. Waits for a human to say "yes" or "no." This is the difference between "helpful automation" and "dangerous automation."

### Modes of Operation

```
# .env configuration:
REQUIRE_HUMAN_APPROVAL=true   → Agent asks before every fix (safest)
REQUIRE_HUMAN_APPROVAL=false  → Agent fixes autonomously (fastest)
AUTO_FIX_ENABLED=false        → Agent can ONLY diagnose, never fix (read-only mode)
```

Start with full approval required. As you build trust in specific actions (restart is always safe), you can selectively make those autonomous.

---

## Making Agents Better Over Time

You don't retrain the LLM. You improve what's AROUND it:

### 1. Add Runbooks (Knowledge)

After every incident, write a new runbook:

```yaml
# runbooks/new_issue_discovered.yaml
alert: SecretRotationFailure
diagnostic_steps:
  - tool: get_recent_logs
    filter: "authentication failed"
remediation:
  - action: restart_service
    rationale: "ECS re-reads secrets on restart"
```

### 2. Add Tools (Capabilities)

Each new function = new capability the agent has.

### 3. Improve System Prompt (Judgment)

Add lessons learned:
```
"IMPORTANT: When you see 'Cluster not found' — this means the infrastructure
was destroyed, not just a service issue. Always escalate this."
```

### 4. Track Outcomes (Feedback Loop)

Log what the agent did and whether it worked. Over time, patterns emerge: "restart_service resolves 80% of ServiceDown alerts" → make that autonomous.

### 5. Test Regularly (Regression)

Run past scenarios through the agent weekly. Ensure new changes didn't break existing capabilities.

---

## Running the Agent

### Demo Mode (No API Key)

```bash
cd agents/sre-agent
python demo.py
# Choose scenario 1 or 2
# Type 'y' when asked for approval
```

### Real Mode (Requires OpenAI or Anthropic Key)

```bash
cd agents/sre-agent
cp .env.example .env
# Edit .env — add your API key

# OpenAI version:
python agent_openai.py "ServiceDown alert. Health check failing."

# Claude version:
python agent.py "High latency detected. p95 is 4 seconds."

# Custom alert:
python agent_openai.py "Database connection errors spiking. Users getting 500s."
```

### What You'll See

```
╭── SRE Agent Activated ──╮
│ ALERT: ServiceDown...    │
╰──────────────────────────╯

── Agent thinking (iteration 1) ──
  → Calling: check_health()
  ← Result: {"status": "unreachable"}
  → Calling: get_ecs_status()
  ← Result: {"running_count": 0}

── Agent thinking (iteration 2) ──
  → Calling: get_recent_logs({"filter_pattern": "error"})
  ← Result: {"logs": ["FATAL: password auth failed"]}

── Agent thinking (iteration 3) ──
  → Calling: restart_service()
  ⚠ APPROVAL REQUIRED: restart_service
  Allow restart_service? [y/N]: y
  ← Result: {"result": "success"}

── Agent thinking (iteration 4) ──
  → Calling: check_health()
  ← Result: {"status": "healthy"}

╭── Agent Report ──╮
│ Status: RESOLVED  │
│ Root Cause: ...   │
│ Action: ...       │
╰──────────────────╯
```

---

## Architecture Decisions

### Why NOT Use LangChain?

| LangChain | Our Approach |
|-----------|-------------|
| Heavy framework (500+ dependencies) | Lightweight (6 dependencies) |
| Abstractions hide what's happening | Every line is visible and understandable |
| Framework lock-in | Swap LLM provider with ~20 lines changed |
| Good for prototyping | Good for production + learning |

For learning and production SRE agents, keeping it simple is better. You understand EXACTLY what's happening.

### Why Separate agent.py and tools.py?

Separation of concerns:
- `agent.py` = HOW the agent thinks (LLM interaction, loop logic)
- `tools.py` = WHAT the agent can do (AWS calls, health checks)

You can:
- Swap the LLM (change agent.py, tools.py unchanged)
- Add capabilities (change tools.py, agent.py unchanged)
- Tighten security (change tools.py guardrails, agent.py unchanged)

### Why YAML Runbooks?

- Human-readable (non-engineers can review them)
- Version-controlled (changes tracked in git)
- Structured (agent can parse them programmatically)
- Extensible (add new runbooks without changing code)

---

## LLM Provider Comparison

| Provider | Model | Cost per Agent Run | Best For |
|----------|-------|-------------------|----------|
| OpenAI | gpt-4o-mini | ~$0.01 | Cheapest, good enough for most tasks |
| OpenAI | gpt-4o | ~$0.05 | Better reasoning, complex diagnosis |
| Anthropic | Claude Sonnet | ~$0.06 | Best at following complex instructions |
| Anthropic | Claude Opus | ~$0.30 | Most capable, expensive |
| AWS Bedrock | Various | ~$0.03 | Stays within AWS ecosystem |
| Local (Ollama) | Llama 3 | $0 (your GPU) | Air-gapped environments, no API costs |

Our agent works with both OpenAI and Anthropic — swap with one env var change.

---

## Real-World Agent Patterns

### Pattern 1: Triage Agent (read-only)

```
Alert fires → Agent diagnoses → Reports findings → Human decides action
```
Safest. Agent never makes changes. Just saves human investigation time.

### Pattern 2: Supervised Agent (our implementation)

```
Alert fires → Agent diagnoses → Proposes fix → Human approves → Agent executes → Verifies
```
Human stays in the loop for decisions. Agent handles the tedious investigation.

### Pattern 3: Autonomous Agent (production-mature)

```
Alert fires → Agent diagnoses → Applies known-safe fix → Verifies → Reports
Human only involved for novel/risky scenarios.
```
Requires high trust built over time. Start with Pattern 2, graduate to Pattern 3.

### Pattern 4: Multi-Agent (advanced)

```
Alert fires → Triage Agent classifies severity
  → Diagnostic Agent investigates
  → Remediation Agent applies fix
  → Verification Agent confirms
  → Communication Agent notifies stakeholders
```
Each agent has a narrow scope and limited tools. More complex but more controllable.

---

## Key Concepts for Interviews

**Q: "What is an AI agent vs a chatbot?"**
A: A chatbot generates text. An agent generates text AND takes actions. It has tools (functions it can call), a loop (keeps going until the problem is solved), and guardrails (safety limits on what it can do).

**Q: "How do you prevent an agent from doing dangerous things?"**
A: Defense in depth: IAM limits what AWS APIs are callable, code enforces hard limits (never scale to 0), human-in-the-loop for remediation actions, tool registry restricts available functions, and everything is logged for audit.

**Q: "How do you make an agent better over time?"**
A: Not by retraining the model. By expanding its knowledge (new runbooks), capabilities (new tools), judgment (improved system prompt with lessons learned), and trust (making proven-safe actions autonomous).

**Q: "What's the difference between your agent and PagerDuty/Shoreline?"**
A: Same concept, different trade-offs. Enterprise tools are black boxes with subscription costs. Our agent is fully custom — we control the tools, guardrails, knowledge base, and LLM provider. Maximum transparency and flexibility, but requires engineering effort to build.

**Q: "How would you integrate this into production?"**
A: CloudWatch Alarm → SNS → Lambda → triggers the agent. Agent runs, diagnoses, applies safe fixes, reports to Slack. For risky actions, it sends a Slack message with approve/deny buttons (interactive message) instead of CLI input.

**Q: "What LLM do you use and why?"**
A: Currently supports both GPT-4o-mini (cheapest, $0.01/run) and Claude Sonnet (best at following complex instructions). The agent architecture is LLM-agnostic — swap provider with one config change. In production, you'd use the cheapest model that handles your runbooks accurately, and upgrade only for complex novel incidents.

---

## What This Project Demonstrates for the Hepapi Role

| Their Requirement | What We Built |
|---|---|
| "AI agent lifecycle — design, deploy, tune, maintain" | Full agent with runbooks, tools, guardrails, and improvement path |
| "Agents that power pre-triage, auto-healing, RCA drafting" | Agent diagnoses (pre-triage), restarts service (auto-healing), generates report (RCA drafting) |
| "When an agent fails, you fix the capability — not just the output" | Add tools, improve prompts, expand runbooks |
| "Safe production execution with tested rollbacks" | Human approval, hard limits, audit trail |
| "AI-native operating style — delegate to agents, evaluate critically" | Exactly what this agent does — delegates diagnosis, human evaluates remediation |
| "Knowledge multiplication — document every procedure" | Runbooks as YAML that both humans AND agents can read |

---
