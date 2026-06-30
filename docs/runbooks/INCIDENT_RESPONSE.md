# Incident Response Playbook

The process for handling production incidents — from detection to postmortem.

---

## Severity Levels

| Level | Definition | Response Time | Example |
|-------|-----------|---------------|---------|
| **P1 (Critical)** | Service is DOWN. Users cannot use the app. | Immediate (< 5 min) | App unreachable, database down |
| **P2 (High)** | Service is degraded. Some users affected. | < 15 min | High error rate, slow responses |
| **P3 (Medium)** | Minor issue. Users mostly unaffected. | < 1 hour | One endpoint failing, cosmetic bug |
| **P4 (Low)** | No user impact. Improvement opportunity. | Next business day | Log noise, non-critical warning |

---

## The Incident Lifecycle

```
DETECT → TRIAGE → MITIGATE → RESOLVE → POSTMORTEM
```

### 1. DETECT (How You Find Out)

| Source | What It Means |
|--------|--------------|
| CloudWatch alarm fires | Automated detection — system metrics breached threshold |
| Slack alert (Alertmanager) | Prometheus detected an issue |
| User reports "it's broken" | Monitoring missed it — need better alerts |
| You notice during routine check | Proactive discovery |

### 2. TRIAGE (First 5 Minutes)

**Goal:** Determine severity and what's broken.

```bash
# Is the app alive?
curl -s https://app.johndesiventures.website/health

# Is the database connected?
curl -s https://app.johndesiventures.website/ready

# Are ECS tasks running?
aws ecs describe-services --cluster church-cms-prod-cluster \
  --services church-cms-prod-service \
  --query 'services[0].{desired:desiredCount,running:runningCount}'

# Any recent errors in logs?
aws logs tail /ecs/church-cms-prod --since 5m --filter-pattern "error"
```

Based on answers, assign severity and jump to the appropriate runbook.

### 3. MITIGATE (Stop the Bleeding)

The goal is NOT to find root cause yet. It's to REDUCE USER IMPACT immediately.

| Situation | Immediate Action |
|-----------|-----------------|
| Bad deploy caused errors | Rollback: `aws ecs update-service --force-new-deployment` with previous image |
| Single task crashing | ECS auto-replaces it — verify it recovers |
| All tasks crashing | Check logs, likely a config/secret issue |
| Database overloaded | Scale ECS to 0 temporarily, investigate DB |
| Traffic spike (DDoS?) | Scale up tasks: `--desired-count 4` |

### 4. RESOLVE (Fix the Root Cause)

Only AFTER users are no longer impacted:
- Identify the actual bug/misconfiguration
- Fix it in code/infrastructure
- Deploy the fix through the normal pipeline (staging first)
- Verify the fix resolves the issue

### 5. POSTMORTEM (Learn From It)

Within 48 hours, write a postmortem:

```markdown
## Incident: [Title]
**Date:** YYYY-MM-DD
**Duration:** X minutes
**Severity:** P1/P2/P3
**Impact:** X users affected, Y% error rate

### Timeline
- HH:MM — Alert fired
- HH:MM — Engineer acknowledged
- HH:MM — Root cause identified
- HH:MM — Mitigation applied
- HH:MM — Fully resolved

### Root Cause
[What actually broke and why]

### What Went Well
- [What worked during the incident]

### What Went Poorly
- [What slowed down detection/resolution]

### Action Items
- [ ] [Preventive measure 1]
- [ ] [Preventive measure 2]
- [ ] [Better alert for this scenario]
```

**Key rule:** Postmortems are BLAMELESS. We don't ask "who caused this?" We ask "what systemic issue allowed this to happen?"

---

## Communication Template

When an incident is happening, communicate in Slack:

```
🚨 INCIDENT — P1 — App unreachable
Status: INVESTIGATING
Impact: All users unable to log in
Lead: @john
Started: 14:30 UTC
Updates every 15 min
```

```
🔄 INCIDENT UPDATE — P1 — App unreachable
Status: MITIGATING
Action: Rolling back to previous deployment
ETA: 5 minutes
```

```
✅ INCIDENT RESOLVED — P1 — App unreachable
Duration: 23 minutes
Root cause: Bad migration caused startup crash
Postmortem: [link] due by Friday
```

---
