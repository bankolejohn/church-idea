#!/usr/bin/env bash
#
# Post-Deploy Integration Test Script
# ────────────────────────────────────────────────────────────────────
#
# WHY THIS EXISTS:
# Cypress E2E tests are great for browser-level testing, but they're
# heavy (install Chrome, run a full browser process). This script is
# a fast, lightweight complement — pure curl-based API testing that
# runs in seconds, no dependencies beyond bash and curl.
#
# In real companies, this is often called a "smoke test" or 
# "deployment verification test (DVT)". It answers ONE question:
# "Did the deploy actually work?"
#
# WHAT IT CHECKS:
# 1. App is responding (health endpoint)
# 2. Database is connected (ready endpoint)
# 3. Auth system works (login + token)
# 4. Core business endpoints respond correctly
# 5. Security headers are present
# 6. Response times are acceptable
#
# USAGE:
#   ./scripts/integration-test.sh https://staging.yourapp.com
#   ./scripts/integration-test.sh http://localhost:3000
#
# EXIT CODES:
#   0 = All tests passed
#   1 = One or more tests failed
#
# ────────────────────────────────────────────────────────────────────

set -euo pipefail

BASE_URL="${1:?Usage: $0 <base_url>}"
ADMIN_USER="${ADMIN_USERNAME:-admin}"
ADMIN_PASS="${ADMIN_PASSWORD:-admin123}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0
WARNINGS=0

# ─────────────────────────────────────────────
# Helper Functions
# ─────────────────────────────────────────────

pass() {
  echo -e "  ${GREEN}✓${NC} $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo -e "  ${RED}✗${NC} $1"
  FAILED=$((FAILED + 1))
}

warn() {
  echo -e "  ${YELLOW}⚠${NC} $1"
  WARNINGS=$((WARNINGS + 1))
}

# Makes a request and returns: http_code|time_total|body
# This lets us check status, latency, and response content in one call
request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local token="${4:-}"

  local curl_args=(
    -s                          # Silent (no progress bar)
    -w '\n%{http_code}|%{time_total}'  # Append status + timing
    -X "$method"
    -H "Content-Type: application/json"
    --max-time 15               # Fail if request takes > 15s
  )

  if [ -n "$token" ]; then
    curl_args+=(-H "Authorization: Bearer $token")
  fi

  if [ -n "$body" ]; then
    curl_args+=(-d "$body")
  fi

  curl "${curl_args[@]}" "${BASE_URL}${url}" 2>/dev/null || echo -e "\n000|0"
}

# Parse response: extracts body, status code, and response time
parse_response() {
  local response="$1"
  local last_line
  last_line=$(echo "$response" | tail -1)
  RESP_BODY=$(echo "$response" | sed '$d')
  RESP_CODE=$(echo "$last_line" | cut -d'|' -f1)
  RESP_TIME=$(echo "$last_line" | cut -d'|' -f2)
}

# ─────────────────────────────────────────────
# Test Suite
# ─────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Integration Tests: ${BASE_URL}"
echo "═══════════════════════════════════════════════════"
echo ""

# ─── 1. Health Check ─────────────────────────
echo "▸ Health & Readiness"

parse_response "$(request GET /health)"
if [ "$RESP_CODE" = "200" ]; then
  pass "GET /health → 200 (${RESP_TIME}s)"
else
  fail "GET /health → $RESP_CODE (expected 200)"
fi

parse_response "$(request GET /ready)"
if [ "$RESP_CODE" = "200" ]; then
  pass "GET /ready → 200 (database connected, ${RESP_TIME}s)"
else
  fail "GET /ready → $RESP_CODE (database may be disconnected)"
fi

echo ""

# ─── 2. Response Time Check ──────────────────
echo "▸ Performance (response time < 2s)"

parse_response "$(request GET /health)"
if (( $(echo "$RESP_TIME < 2.0" | bc -l 2>/dev/null || echo 1) )); then
  pass "/health response time: ${RESP_TIME}s"
else
  warn "/health slow: ${RESP_TIME}s (should be < 2s)"
fi

echo ""

# ─── 3. Security Headers ─────────────────────
echo "▸ Security Headers"

HEADERS=$(curl -s -D - -o /dev/null "${BASE_URL}/health" 2>/dev/null)

if echo "$HEADERS" | grep -qi "x-content-type-options: nosniff"; then
  pass "X-Content-Type-Options: nosniff"
else
  fail "Missing X-Content-Type-Options header"
fi

if echo "$HEADERS" | grep -qi "x-frame-options"; then
  pass "X-Frame-Options present"
else
  fail "Missing X-Frame-Options header"
fi

if echo "$HEADERS" | grep -qi "x-request-id"; then
  pass "X-Request-Id (request tracing) present"
else
  warn "Missing X-Request-Id header (tracing may not work)"
fi

echo ""

# ─── 4. Authentication ───────────────────────
echo "▸ Authentication"

# Test invalid login
parse_response "$(request POST /api/login '{"username":"fake","password":"wrong"}')"
if [ "$RESP_CODE" = "401" ]; then
  pass "Invalid login → 401 (correct rejection)"
else
  fail "Invalid login → $RESP_CODE (expected 401)"
fi

# Test no-auth access
parse_response "$(request GET /api/members)"
if [ "$RESP_CODE" = "401" ]; then
  pass "Unauthenticated /api/members → 401"
else
  fail "Unauthenticated /api/members → $RESP_CODE (expected 401)"
fi

# Test valid login (requires seed data)
parse_response "$(request POST /api/login "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")"
if [ "$RESP_CODE" = "200" ]; then
  TOKEN=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    pass "Admin login → 200 (token received)"
  else
    fail "Admin login → 200 but no token in response"
  fi
else
  warn "Admin login → $RESP_CODE (seed data may not exist — skipping auth-dependent tests)"
  TOKEN=""
fi

echo ""

# ─── 5. Core Business Endpoints ──────────────
echo "▸ Business Endpoints"

if [ -n "$TOKEN" ]; then
  # Branches
  parse_response "$(request GET /api/branches '' "$TOKEN")"
  if [ "$RESP_CODE" = "200" ]; then
    pass "GET /api/branches → 200 (${RESP_TIME}s)"
  else
    fail "GET /api/branches → $RESP_CODE (expected 200)"
  fi

  # Members
  parse_response "$(request GET '/api/members?page=1&limit=5' '' "$TOKEN")"
  if [ "$RESP_CODE" = "200" ]; then
    pass "GET /api/members?page=1&limit=5 → 200 (${RESP_TIME}s)"
  else
    fail "GET /api/members → $RESP_CODE (expected 200)"
  fi

  # Stats
  parse_response "$(request GET /api/stats '' "$TOKEN")"
  if [ "$RESP_CODE" = "200" ]; then
    pass "GET /api/stats → 200 (${RESP_TIME}s)"
  else
    fail "GET /api/stats → $RESP_CODE (expected 200)"
  fi

  # User info
  parse_response "$(request GET /api/me '' "$TOKEN")"
  if [ "$RESP_CODE" = "200" ]; then
    pass "GET /api/me → 200 (${RESP_TIME}s)"
  else
    fail "GET /api/me → $RESP_CODE (expected 200)"
  fi
else
  warn "Skipping business endpoints (no auth token)"
fi

echo ""

# ─── 6. Error Handling ───────────────────────
echo "▸ Error Handling"

# Invalid JSON body
parse_response "$(request POST /api/login 'not-json')"
if [ "$RESP_CODE" = "400" ]; then
  pass "Invalid JSON → 400"
elif [ "$RESP_CODE" = "500" ]; then
  fail "Invalid JSON → 500 (should be 400, app isn't handling this)"
else
  pass "Invalid JSON → $RESP_CODE (handled)"
fi

# Non-existent API route should not leak stack trace
parse_response "$(request GET /api/nonexistent)"
if echo "$RESP_BODY" | grep -qi "stack\|trace\|error at"; then
  fail "Error response leaks stack trace (security issue)"
else
  pass "Error responses don't leak internals"
fi

echo ""

# ─── Results ─────────────────────────────────
echo "═══════════════════════════════════════════════════"
echo -e "  Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${WARNINGS} warnings${NC}"
echo "═══════════════════════════════════════════════════"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}DEPLOYMENT VERIFICATION FAILED${NC}"
  echo "Do NOT promote this build to production."
  exit 1
else
  echo -e "${GREEN}DEPLOYMENT VERIFIED${NC}"
  if [ "$WARNINGS" -gt 0 ]; then
    echo "There are warnings — review them but they're not blocking."
  fi
  exit 0
fi
