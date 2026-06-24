/**
 * k6 Soak Test
 * ────────────────────────────────────────────────────────────────────
 *
 * PURPOSE:
 * Run moderate load for an extended period to detect:
 *   - Memory leaks (heap grows over time, never shrinks)
 *   - Connection pool leaks (active connections climb, never release)
 *   - Gradual performance degradation (latency slowly increases)
 *   - Resource exhaustion over time
 *
 * WHAT IT DOES:
 *   - Ramps to 30 VUs (realistic steady-state traffic)
 *   - Holds for 15 minutes (enough to spot trends)
 *   - Ramps down
 *
 * WHAT TO WATCH:
 *   - Infrastructure dashboard: memory should stay FLAT, not climb
 *   - DB pool: active connections should be steady, not growing
 *   - Latency: should remain consistent, not slowly increasing
 *
 * IN PRODUCTION:
 *   You'd run this for 1-4 hours. For local testing, 15min is enough
 *   to spot obvious leaks.
 *
 * USAGE:
 *   k6 run load-testing/scripts/soak.js
 *
 * ────────────────────────────────────────────────────────────────────
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
    stages: [
        { duration: '1m', target: 30 },     // Ramp up
        { duration: '15m', target: 30 },    // Sustained load
        { duration: '1m', target: 0 },      // Ramp down
    ],

    thresholds: {
        http_req_duration: ['p(95)<2000'],
        http_req_failed: ['rate<0.02'],
    },
};

export default function () {
    // Realistic user session
    const loginRes = http.post(
        `${BASE_URL}/api/login`,
        JSON.stringify({ username: 'admin', password: 'admin123' }),
        { headers: { 'Content-Type': 'application/json' } }
    );

    if (loginRes.status !== 200) {
        sleep(2);
        return;
    }

    const token = loginRes.json().token;
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    // Simulate a typical user session
    http.get(`${BASE_URL}/api/stats`, auth);
    sleep(1);

    http.get(`${BASE_URL}/api/branches`, auth);
    sleep(0.5);

    http.get(`${BASE_URL}/api/members?page=1&limit=20`, auth);
    sleep(1);

    http.get(`${BASE_URL}/api/members?page=2&limit=20`, auth);
    sleep(2);

    // Longer pause between sessions (user reading data)
    sleep(Math.random() * 3 + 2);
}
