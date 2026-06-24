/**
 * k6 Spike Test
 * ────────────────────────────────────────────────────────────────────
 *
 * PURPOSE:
 * Simulate a sudden traffic spike — what happens when load goes from
 * normal to extreme in seconds? Does the system:
 *   - Handle it gracefully (queue requests, scale up)?
 *   - Degrade gracefully (slower but still working)?
 *   - Fall over completely (cascade failure)?
 *
 * REAL-WORLD SCENARIOS:
 *   - Sunday morning: all pastors open the app at 8:55am
 *   - A viral social media post sends unexpected traffic
 *   - A retry storm after a brief outage
 *   - A bot/crawler hitting your API
 *
 * WHAT IT DOES:
 *   - Normal load (10 VUs) for 1 minute
 *   - INSTANT spike to 200 VUs (simulates sudden burst)
 *   - Holds spike for 1 minute
 *   - Drops back to normal (10 VUs)
 *   - Holds to verify recovery
 *
 * WHAT TO WATCH:
 *   - Does rate limiting kick in? (expect 429 responses)
 *   - Does the DB pool exhaust? (waiting_clients > 0)
 *   - Does the app crash/restart? (check container health)
 *   - Does it RECOVER after the spike passes? (latency returns to normal)
 *
 * USAGE:
 *   k6 run load-testing/scripts/spike.js
 *
 * ────────────────────────────────────────────────────────────────────
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const rateLimited = new Rate('rate_limited');

export const options = {
    stages: [
        // Normal traffic
        { duration: '1m', target: 10 },
        // SPIKE — sudden burst
        { duration: '10s', target: 200 },
        // Hold the spike
        { duration: '1m', target: 200 },
        // Drop back to normal
        { duration: '10s', target: 10 },
        // Recovery period — does performance return to baseline?
        { duration: '2m', target: 10 },
    ],

    thresholds: {
        // More lenient during spikes — we expect some degradation
        http_req_duration: ['p(95)<5000'],   // Under 5s even during spike
        http_req_failed: ['rate<0.20'],       // Allow up to 20% failures (rate limiting is expected)
    },
};

export default function () {
    // Mix of requests to simulate real traffic

    // Health check (lightweight)
    http.get(`${BASE_URL}/health`);

    // Login attempt
    const loginRes = http.post(
        `${BASE_URL}/api/login`,
        JSON.stringify({ username: 'admin', password: 'admin123' }),
        { headers: { 'Content-Type': 'application/json' } }
    );

    // Track rate limiting
    if (loginRes.status === 429) {
        rateLimited.add(1);
        check(loginRes, {
            'rate limited: returns 429': (r) => r.status === 429,
        });
        sleep(1);
        return;
    }
    rateLimited.add(0);

    if (loginRes.status === 200) {
        const token = loginRes.json().token;
        const auth = { headers: { Authorization: `Bearer ${token}` } };

        // Quick API calls
        http.get(`${BASE_URL}/api/stats`, auth);
        http.get(`${BASE_URL}/api/branches`, auth);
        http.get(`${BASE_URL}/api/members?page=1&limit=10`, auth);
    }

    sleep(0.5);
}
