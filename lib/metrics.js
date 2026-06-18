/**
 * Prometheus Metrics Module
 * ────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * OpenTelemetry gives you auto-instrumented metrics (HTTP request duration, etc.)
 * but it doesn't know about YOUR business. This module adds custom metrics that
 * answer business and operational questions:
 *
 * OPERATIONAL METRICS (for SREs):
 * - How many requests per second? (request rate)
 * - How fast are responses? (latency histogram)
 * - How many errors? (error rate)
 * - Is the DB pool exhausted? (active connections)
 *
 * BUSINESS METRICS (for stakeholders):
 * - How many logins today? (successful vs failed)
 * - How many members were added? (growth tracking)
 * - How many branches are being managed? (usage)
 *
 * HOW PROMETHEUS WORKS (simplified):
 * 1. Your app exposes metrics at GET /metrics in a text format
 * 2. Prometheus server scrapes that endpoint every 15-30 seconds
 * 3. Prometheus stores the time-series data
 * 4. Grafana queries Prometheus to build dashboards
 * 5. Alertmanager fires alerts when thresholds are breached
 *
 * METRIC TYPES:
 * - Counter: only goes up (e.g., total requests, total errors)
 * - Gauge: goes up and down (e.g., active connections, memory usage)
 * - Histogram: measures distribution (e.g., request duration buckets)
 * - Summary: like histogram but calculates percentiles client-side
 *
 * ────────────────────────────────────────────────────────────────────
 */

'use strict';

const client = require('prom-client');

// ─── Default Metrics ─────────────────────────────────────────────
// Collects Node.js runtime metrics automatically:
// - process_cpu_seconds_total
// - process_resident_memory_bytes
// - nodejs_active_handles_total
// - nodejs_heap_size_used_bytes
// - nodejs_eventloop_lag_seconds
// - nodejs_gc_duration_seconds
client.collectDefaultMetrics({
    prefix: 'churchcms_',
    labels: { service: 'church-cms', env: process.env.NODE_ENV || 'development' }
});

// ─── HTTP Metrics ────────────────────────────────────────────────

const httpRequestDuration = new client.Histogram({
    name: 'churchcms_http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

const httpRequestsTotal = new client.Counter({
    name: 'churchcms_http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code']
});

const httpActiveRequests = new client.Gauge({
    name: 'churchcms_http_active_requests',
    help: 'Number of HTTP requests currently being processed',
    labelNames: ['method']
});

// ─── Database Metrics ────────────────────────────────────────────

const dbQueryDuration = new client.Histogram({
    name: 'churchcms_db_query_duration_seconds',
    help: 'Duration of database queries in seconds',
    labelNames: ['operation', 'success'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]
});

const dbPoolActive = new client.Gauge({
    name: 'churchcms_db_pool_active_connections',
    help: 'Number of active database connections in the pool'
});

const dbPoolIdle = new client.Gauge({
    name: 'churchcms_db_pool_idle_connections',
    help: 'Number of idle database connections in the pool'
});

const dbPoolWaiting = new client.Gauge({
    name: 'churchcms_db_pool_waiting_clients',
    help: 'Number of clients waiting for a database connection'
});

// ─── Authentication Metrics ──────────────────────────────────────

const loginAttemptsTotal = new client.Counter({
    name: 'churchcms_login_attempts_total',
    help: 'Total login attempts',
    labelNames: ['status'] // 'success' or 'failure'
});

const activeSessionsGauge = new client.Gauge({
    name: 'churchcms_active_sessions',
    help: 'Estimated number of active user sessions (tokens issued in last 24h)'
});

// ─── Business Metrics ────────────────────────────────────────────

const membersCreatedTotal = new client.Counter({
    name: 'churchcms_members_created_total',
    help: 'Total number of members created',
    labelNames: ['branch_id']
});

const membersDeletedTotal = new client.Counter({
    name: 'churchcms_members_deleted_total',
    help: 'Total number of members deleted',
    labelNames: ['branch_id']
});

const branchesCreatedTotal = new client.Counter({
    name: 'churchcms_branches_created_total',
    help: 'Total number of branches created'
});

const pastorAccountsCreatedTotal = new client.Counter({
    name: 'churchcms_pastor_accounts_created_total',
    help: 'Total number of pastor accounts created'
});

// ─── Application Info ────────────────────────────────────────────

const appInfo = new client.Gauge({
    name: 'churchcms_app_info',
    help: 'Application information',
    labelNames: ['version', 'node_version', 'environment']
});

// Set once at startup
appInfo.set(
    {
        version: process.env.npm_package_version || '2.0.0',
        node_version: process.version,
        environment: process.env.NODE_ENV || 'development'
    },
    1
);

// ─── Express Middleware ──────────────────────────────────────────

/**
 * Middleware that records HTTP request metrics.
 * Attach BEFORE your routes:
 *   app.use(metrics.httpMiddleware);
 */
function httpMiddleware(req, res, next) {
    // Skip metrics/health endpoints to avoid noise
    if (req.path === '/metrics' || req.path === '/health' || req.path === '/ready') {
        return next();
    }

    const start = process.hrtime.bigint();
    httpActiveRequests.inc({ method: req.method });

    // Capture when response finishes
    res.on('finish', () => {
        const durationNs = Number(process.hrtime.bigint() - start);
        const durationSec = durationNs / 1e9;

        // Normalize route to avoid high-cardinality labels
        // e.g., /api/members/123 → /api/members/:id
        const route = normalizeRoute(req.route?.path || req.path, req.method);
        const statusCode = res.statusCode.toString();

        httpRequestDuration.observe({ method: req.method, route, status_code: statusCode }, durationSec);
        httpRequestsTotal.inc({ method: req.method, route, status_code: statusCode });
        httpActiveRequests.dec({ method: req.method });
    });

    next();
}

/**
 * Normalize routes to prevent cardinality explosion.
 * /api/members/42 → /api/members/:id
 * /api/branches/7 → /api/branches/:id
 */
function normalizeRoute(path, method) {
    if (!path) return 'unknown';
    // Replace numeric path segments with :id
    return path.replace(/\/\d+/g, '/:id');
}

// ─── Database Pool Metrics Collector ─────────────────────────────

/**
 * Call this with your pg Pool instance to track connection pool stats.
 * Usage: metrics.trackPool(pool);
 */
function trackPool(pool) {
    // Collect pool stats every 5 seconds
    setInterval(() => {
        dbPoolActive.set(pool.totalCount - pool.idleCount);
        dbPoolIdle.set(pool.idleCount);
        dbPoolWaiting.set(pool.waitingCount);
    }, 5000);
}

// ─── Metrics Endpoint Handler ────────────────────────────────────

/**
 * Express route handler for GET /metrics
 * Returns metrics in Prometheus text exposition format.
 */
async function metricsEndpoint(req, res) {
    try {
        res.set('Content-Type', client.register.contentType);
        const metrics = await client.register.metrics();
        res.end(metrics);
    } catch (error) {
        res.status(500).end('Error collecting metrics');
    }
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    // Express integration
    httpMiddleware,
    metricsEndpoint,
    trackPool,

    // Counters for use in route handlers
    loginAttemptsTotal,
    activeSessionsGauge,
    membersCreatedTotal,
    membersDeletedTotal,
    branchesCreatedTotal,
    pastorAccountsCreatedTotal,

    // DB query tracking (wrap your queries with this)
    dbQueryDuration,

    // Raw prom-client access (for advanced use)
    client,
    register: client.register
};
