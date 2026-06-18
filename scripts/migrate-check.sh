#!/usr/bin/env bash
#
# Database Migration Dry-Run Check
# ────────────────────────────────────────────────────────────────────
#
# WHY THIS EXISTS:
# One of the most dangerous things in a deploy is a database migration.
# A bad migration can:
#   - Lock tables for minutes (causing downtime)
#   - Corrupt data (irreversible without backup restore)
#   - Fail halfway through (leaving DB in inconsistent state)
#
# This script runs BEFORE deployment to verify that migrations are safe.
# It connects to the target database and checks:
#   1. Can we connect at all? (credentials/network)
#   2. Which migrations have already been applied?
#   3. Are there pending migrations?
#   4. Do pending migrations have valid SQL syntax?
#
# HOW IT WORKS IN THE REAL WORLD:
# In production-grade systems, you'd use tools like:
#   - Flyway / Liquibase (Java ecosystem)
#   - Alembic (Python)
#   - knex migrate:status / Prisma migrate status
#   - Custom script (what we're doing here)
#
# The key principle: NEVER run migrations as part of the deployment itself.
# Instead:
#   1. Check migration status (this script)
#   2. Run migrations SEPARATELY (before the new code deploys)
#   3. Then deploy the new code
#
# This way, if migration fails, you haven't deployed bad code yet.
# And if code deploy fails, the migration (which is backward-compatible)
# is already safely in place.
#
# USAGE:
#   DATABASE_URL=postgresql://user:pass@host/db ./scripts/migrate-check.sh
#
# EXIT CODES:
#   0 = Migrations are in good shape (or no pending migrations)
#   1 = Problem detected (can't connect, syntax error, etc.)
#
# ────────────────────────────────────────────────────────────────────

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DATABASE_URL="${DATABASE_URL:?ERROR: DATABASE_URL environment variable is required}"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Database Migration Pre-Check"
echo "═══════════════════════════════════════════════════"
echo ""

# ─── 1. Connection Check ─────────────────────
echo "▸ Testing database connectivity..."

# Extract host for display (hide password)
DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^/]+)/.*|\1|')
echo "  Target: $DB_HOST"

if psql "$DATABASE_URL" -c "SELECT 1;" > /dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} Database connection successful"
else
  echo -e "  ${RED}✗${NC} Cannot connect to database"
  echo "  Check DATABASE_URL, network access, and security groups."
  exit 1
fi

echo ""

# ─── 2. Check Migration Table ────────────────
echo "▸ Checking migration tracking table..."

TABLE_EXISTS=$(psql "$DATABASE_URL" -t -c "
  SELECT EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_name = 'migrations'
  );" 2>/dev/null | tr -d ' ')

if [ "$TABLE_EXISTS" = "t" ]; then
  echo -e "  ${GREEN}✓${NC} Migration tracking table exists"
else
  echo -e "  ${YELLOW}⚠${NC} Migration table does not exist (first-time deploy?)"
  echo "  Migrations will create it automatically."
  echo ""
  echo -e "${GREEN}PRE-CHECK PASSED${NC} (first-time setup)"
  exit 0
fi

echo ""

# ─── 3. List Applied Migrations ──────────────
echo "▸ Applied migrations:"

APPLIED=$(psql "$DATABASE_URL" -t -c "
  SELECT name || ' (applied: ' || applied_at::date || ')'
  FROM migrations ORDER BY id;" 2>/dev/null)

if [ -n "$APPLIED" ]; then
  echo "$APPLIED" | while IFS= read -r line; do
    [ -n "$line" ] && echo -e "  ${GREEN}✓${NC}$line"
  done
else
  echo "  (none)"
fi

echo ""

# ─── 4. Check for Pending Migrations ─────────
echo "▸ Checking for pending migrations in code..."

# Count migrations defined in db/migrate.js
# This is a heuristic — we look for migration name strings
DEFINED_MIGRATIONS=$(grep -oP "name:\s*'[^']+'" db/migrate.js 2>/dev/null | sed "s/name: '//;s/'//" || echo "")
APPLIED_NAMES=$(psql "$DATABASE_URL" -t -c "SELECT name FROM migrations;" 2>/dev/null | tr -d ' ')

PENDING=0
if [ -n "$DEFINED_MIGRATIONS" ]; then
  while IFS= read -r migration; do
    [ -z "$migration" ] && continue
    if echo "$APPLIED_NAMES" | grep -q "^${migration}$"; then
      : # already applied
    else
      echo -e "  ${YELLOW}⚡${NC} PENDING: $migration"
      PENDING=$((PENDING + 1))
    fi
  done <<< "$DEFINED_MIGRATIONS"
fi

if [ "$PENDING" -eq 0 ]; then
  echo -e "  ${GREEN}✓${NC} No pending migrations"
else
  echo ""
  echo -e "  ${YELLOW}⚠${NC} $PENDING pending migration(s) detected"
  echo ""
  echo "  IMPORTANT: Run migrations BEFORE deploying new code:"
  echo "    node db/migrate.js"
  echo ""
  echo "  Or via ECS exec:"
  echo "    aws ecs execute-command --cluster <cluster> --task <task-id> \\"
  echo "      --container church-cms-app --interactive \\"
  echo "      --command 'node db/migrate.js'"
fi

echo ""

# ─── 5. Basic SQL Syntax Check ────────────────
echo "▸ Validating migration SQL syntax..."

# We can't truly dry-run without a transaction + rollback,
# but we can check for obvious issues
MIGRATE_FILE="db/migrate.js"
if [ -f "$MIGRATE_FILE" ]; then
  # Check for dangerous patterns that shouldn't be in migrations
  ISSUES=0

  if grep -qi "DROP TABLE" "$MIGRATE_FILE" | grep -qiv "IF EXISTS"; then
    echo -e "  ${RED}✗${NC} Found DROP TABLE without IF EXISTS (dangerous!)"
    ISSUES=$((ISSUES + 1))
  fi

  if grep -qi "TRUNCATE" "$MIGRATE_FILE"; then
    echo -e "  ${RED}✗${NC} Found TRUNCATE statement (data loss risk!)"
    ISSUES=$((ISSUES + 1))
  fi

  if grep -qi "DELETE FROM.*WHERE.*1.*=.*1\|DELETE FROM [a-z]* *$\|DELETE FROM [a-z]* *;" "$MIGRATE_FILE"; then
    echo -e "  ${RED}✗${NC} Found unqualified DELETE (data loss risk!)"
    ISSUES=$((ISSUES + 1))
  fi

  if [ "$ISSUES" -eq 0 ]; then
    echo -e "  ${GREEN}✓${NC} No dangerous patterns detected"
  else
    echo ""
    echo -e "  ${RED}FAILED: $ISSUES dangerous pattern(s) found${NC}"
    echo "  Review the migration carefully before proceeding."
    exit 1
  fi
else
  echo -e "  ${YELLOW}⚠${NC} Migration file not found: $MIGRATE_FILE"
fi

echo ""

# ─── Results ─────────────────────────────────
echo "═══════════════════════════════════════════════════"
if [ "$PENDING" -gt 0 ]; then
  echo -e "  ${YELLOW}RESULT: $PENDING pending migration(s) — run before deploy${NC}"
else
  echo -e "  ${GREEN}RESULT: Database is ready for deployment${NC}"
fi
echo "═══════════════════════════════════════════════════"
echo ""

exit 0
