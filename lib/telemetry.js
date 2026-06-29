/**
 * OpenTelemetry Instrumentation
 * ────────────────────────────────────────────────────────────────────
 *
 * WHY THIS FILE EXISTS:
 * OpenTelemetry (OTel) is the industry standard for observability.
 * It gives you three pillars of visibility into your application:
 *
 * 1. TRACES — Follow a single request through your entire system
 *    (e.g., HTTP request → Express handler → PostgreSQL query → response)
 *    Each step is a "span" with timing, status, and metadata.
 *
 * 2. METRICS — Numerical measurements aggregated over time
 *    (e.g., request count, latency percentiles, DB connection pool usage)
 *    Prometheus scrapes these for dashboards and alerting.
 *
 * 3. LOGS — Structured logs correlated with traces
 *    (e.g., "User login failed" with trace_id attached so you can find
 *    the exact request in your tracing system)
 *
 * HOW IT WORKS:
 * This file must be REQUIRED BEFORE your app code loads.
 * It patches Node.js modules (http, pg, express) at load time,
 * wrapping them to automatically emit traces and metrics.
 *
 * In production, it sends traces to an OTLP collector (Jaeger, Tempo, etc.)
 * In development, it prints traces to console for visibility.
 *
 * USAGE:
 *   node --require ./lib/telemetry.js server.js
 *   OR: require('./lib/telemetry') at the very top of server.js
 *
 * ────────────────────────────────────────────────────────────────────
 */

'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } = require('@opentelemetry/semantic-conventions');

// ─── Configuration ───────────────────────────────────────────────
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'church-cms';
const SERVICE_VERSION = process.env.npm_package_version || '2.0.0';
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const PROMETHEUS_PORT = parseInt(process.env.PROMETHEUS_METRICS_PORT) || 9464;
const OTEL_ENABLED = process.env.OTEL_ENABLED !== 'false'; // Enabled by default

if (!OTEL_ENABLED) {
    console.log('[telemetry] OpenTelemetry disabled via OTEL_ENABLED=false');
    module.exports = { shutdown: () => Promise.resolve() };
} else {
// ─── Wrapped in else block to avoid top-level return (breaks Jest/Babel) ───

// ─── Resource (identifies this service in traces/metrics) ─────────
const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: ENVIRONMENT,
});

// ─── Trace Exporter ──────────────────────────────────────────────
// Sends traces to an OTLP-compatible collector (Jaeger, Tempo, etc.)
const traceExporter = new OTLPTraceExporter({
    url: `${OTLP_ENDPOINT}/v1/traces`,
});

// ─── Metrics ─────────────────────────────────────────────────────
// Two metric exporters:
// 1. Prometheus (pull-based) — Prometheus scrapes /metrics endpoint
// 2. OTLP (push-based) — pushes to a collector (optional, for Grafana Cloud etc.)

const prometheusExporter = new PrometheusExporter({
    port: PROMETHEUS_PORT,
    preventServerStart: false, // Starts its own HTTP server on PROMETHEUS_PORT
});

const otlpMetricExporter = new OTLPMetricExporter({
    url: `${OTLP_ENDPOINT}/v1/metrics`,
});

const periodicMetricReader = new PeriodicExportingMetricReader({
    exporter: otlpMetricExporter,
    exportIntervalMillis: 30000, // Push metrics every 30s
});

// ─── Auto-Instrumentation ────────────────────────────────────────
// This is the magic. It patches these modules at load time:
// - express: creates spans for each route handler
// - http/https: creates spans for outbound HTTP calls
// - pg: creates spans for every database query (with SQL)
// - dns: tracks DNS resolution time
// - winston: correlates log entries with active trace
const instrumentations = getNodeAutoInstrumentations({
    // Disable noisy instrumentations we don't need
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: true },
    '@opentelemetry/instrumentation-net': { enabled: false },

    // Configure HTTP instrumentation
    '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => {
            // Don't trace health checks (they're too noisy)
            const url = req.url || '';
            return url === '/health' || url === '/ready' || url === '/metrics';
        },
    },

    // Configure Express instrumentation
    '@opentelemetry/instrumentation-express': {
        enabled: true,
    },

    // Configure PostgreSQL instrumentation
    '@opentelemetry/instrumentation-pg': {
        enhancedDatabaseReporting: true, // Include query text in spans
        addSqlCommenterCommentToQueries: true, // Add trace context as SQL comment
    },

    // Winston log correlation
    '@opentelemetry/instrumentation-winston': {
        enabled: true, // Injects trace_id and span_id into log entries
    },
});

// ─── SDK Initialization ──────────────────────────────────────────
const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: prometheusExporter,
    instrumentations,
});

// Start the SDK
try {
    sdk.start();
    console.log(`[telemetry] OpenTelemetry initialized`);
    console.log(`[telemetry]   Service: ${SERVICE_NAME}@${SERVICE_VERSION} (${ENVIRONMENT})`);
    console.log(`[telemetry]   Traces → ${OTLP_ENDPOINT}/v1/traces`);
    console.log(`[telemetry]   Metrics → Prometheus :${PROMETHEUS_PORT}/metrics`);
} catch (error) {
    console.error('[telemetry] Failed to initialize OpenTelemetry:', error.message);
    console.error('[telemetry] Continuing without telemetry...');
}

// ─── Graceful Shutdown ───────────────────────────────────────────
async function shutdown() {
    try {
        await sdk.shutdown();
        console.log('[telemetry] OpenTelemetry shut down successfully');
    } catch (error) {
        console.error('[telemetry] Error shutting down OpenTelemetry:', error.message);
    }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { shutdown };

} // end of else (OTEL_ENABLED)
