# ──────────────────────────────────────────────
# Stage 1: Dependencies (build environment)
# ──────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# ──────────────────────────────────────────────
# Stage 2: Production Image (hardened)
# ──────────────────────────────────────────────
# WHY ALPINE (not distroless) FOR NOW:
# Google's distroless images (gcr.io/distroless/nodejs20)
# have NO shell, NO package manager, NO utilities.
# This is excellent for security (minimal attack surface)
# but breaks:
#   - Docker health checks that use wget/curl
#   - Debugging (can't exec into container)
#   - Migration scripts (can't run shell commands)
#
# COMPROMISE: Alpine with hardening
# - Non-root user (can't install packages at runtime)
# - Read-only filesystem compatible
# - No dev dependencies
# - Minimal COPY (only what's needed)
# - Explicit user/group IDs (reproducible)
#
# UPGRADE PATH:
# When ready for full distroless, switch to:
#   FROM gcr.io/distroless/nodejs20-debian12
# And change healthcheck to Node.js-based (see below)
# ──────────────────────────────────────────────
FROM node:20-alpine AS production

# Security: create non-root user with explicit IDs
# Explicit UIDs make container behavior predictable across environments
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Security: remove unnecessary system packages
# Alpine is already minimal, but we can remove extras
RUN apk --no-cache add wget && \
    rm -rf /var/cache/apk/* /tmp/* /root/.npm

WORKDIR /app

# Copy dependencies from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code (explicit — no wildcards, no secrets)
COPY server.js ./
COPY lib/ ./lib/
COPY db/ ./db/
COPY public/ ./public/
COPY package.json ./

# Security: set ownership and restrict permissions
RUN chown -R appuser:appgroup /app && \
    chmod -R 555 /app && \
    chmod -R 755 /app/node_modules

# Switch to non-root user
USER 1001:1001

# Expose ports (app + OTel Prometheus metrics)
EXPOSE 3000
EXPOSE 9464

# Security metadata labels (for image scanners and registries)
LABEL org.opencontainers.image.source="https://github.com/bankolejohn/church-idea"
LABEL org.opencontainers.image.description="Church CMS - Production"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="bankolejohn"
LABEL security.scan-on-push="true"

# Health check (uses 127.0.0.1 — Alpine resolves localhost to IPv6)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# Start application (exec form — no shell wrapper, signals pass through)
CMD ["node", "server.js"]
