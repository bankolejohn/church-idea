/**
 * Structured Logger (Winston + OpenTelemetry Correlation)
 * ────────────────────────────────────────────────────────────────────
 *
 * WHY STRUCTURED LOGGING MATTERS:
 * In the old days, logs were free-text: "User admin logged in at 2pm"
 * This is human-readable but IMPOSSIBLE to search/filter at scale.
 *
 * Structured logging outputs JSON:
 * {"level":"info","message":"User logged in","username":"admin","timestamp":"..."}
 *
 * This lets you:
 * - Filter: {service="church-cms"} | json | level="error"
 * - Aggregate: count errors per minute by route
 * - Correlate: find the exact trace for a failed request via trace_id
 *
 * THE THREE PILLARS CONNECTION:
 * When OpenTelemetry is active, every log entry gets:
 * - trace_id: links this log to its distributed trace in Jaeger
 * - span_id: links to the specific operation within the trace
 *
 * This means: you see an error in Loki → click trace_id → see the
 * full request lifecycle in Jaeger. That's the power of correlation.
 *
 * ────────────────────────────────────────────────────────────────────
 */

'use strict';

const winston = require('winston');
const { trace, context } = require('@opentelemetry/api');

// ─── Custom Format: Inject Trace Context ─────────────────────────
// This format extracts the active trace/span IDs from OpenTelemetry
// and injects them into every log entry.
const traceContextFormat = winston.format((info) => {
    const span = trace.getSpan(context.active());
    if (span) {
        const spanContext = span.spanContext();
        info.trace_id = spanContext.traceId;
        info.span_id = spanContext.spanId;
        info.trace_flags = spanContext.traceFlags;
    }
    return info;
});

// ─── Logger Configuration ────────────────────────────────────────
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'ISO' }),
        winston.format.errors({ stack: true }),
        traceContextFormat(),
        // Always output JSON — even in dev (Loki needs it, and you should get used to reading it)
        process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT === 'json'
            ? winston.format.json()
            : winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, trace_id, ...meta }) => {
                    const traceStr = trace_id ? ` [trace:${trace_id.slice(0, 8)}]` : '';
                    const metaStr = Object.keys(meta).length > 0
                        ? ` ${JSON.stringify(meta)}`
                        : '';
                    return `${timestamp} ${level}: ${message}${traceStr}${metaStr}`;
                })
            )
    ),
    defaultMeta: {
        service: 'church-cms',
        environment: process.env.NODE_ENV || 'development',
        version: process.env.npm_package_version || '2.0.0'
    },
    transports: [
        new winston.transports.Console()
    ]
});

// ─── Child Logger Factory ────────────────────────────────────────
// Creates a child logger with additional context (useful for per-module logging)
// Usage: const log = logger.child({ module: 'auth' });
logger.child = (metadata) => {
    return winston.createLogger({
        ...logger,
        defaultMeta: { ...logger.defaultMeta, ...metadata }
    });
};

module.exports = logger;
