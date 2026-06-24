/**
 * k6 Stress Test
 * ────────────────────────────────────────────────────────────────────
 *
 * PURPOSE:
 * Push the system beyond normal load to find the breaking point.
 * This simulates traffic spikes — like a Sunday morning when every
 * branch pastor logs in simultaneously.
 *
 * WHAT IT DOES:
 * Ramps up from 0 → 50 → 100 → 150 VUs, holds at each level,
 * then ramps back down. This creates a pyramid-shaped load pattern
 * that reveals:
 *   - At what load does latency start degrading?
 *   - At what load do errors start appearing?
 *   - Does the system recover after the spike passes?
 *
 * STAGES:
 *   0→50 VUs (1min) → Hold (2min) → 50→100 VUs (1min) → Hold (2min)
 *   → 100→150 VUs (1min) → Hold (2min) → Ramp down (1min)
 *
 * WHAT TO WATCH IN GRAFANA DURING THIS TEST:
 *   - Application Overview: request rate should climb, latency should stay flat
 *     (if latency climbs with load = bottleneck)
 *   - Infrastructure: DB pool connections should approach max under peak load
 *   - Alerts: watch if any fire (HighLatency, DBPoolExhausted)
 *
 * USAGE:
 *   k6 run load-testing/scripts/stress.js
 *   k6 run --env BASE_URL=https://staging.example.com load-testing/scripts/stress.js
 *
 * ────────────────────────────────────────────────────────────────────
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ─── Custom Metrics ──────────────────────────────────────────────
// These show up in k6 output and can be exported to Prometheus
const loginDuration = new Trend('login_duration', true);
const apiErrors = new Rate('api_errors');

// ─── Configuration ───────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
    stages: [
        // Ramp up to 50 VUs
        { duration: '1m', target: 50 },
        // Hold at 50
        { duration: '2m', target: 50 },
        // Ramp up to 100
        { duration: '1m', target: 100 },
        // Hold at 100
        { duration: '2m', target: 100 },
        // Spike to 150
        { duration: '1m', target: 150 },
        // Hold at peak
        { duration: '2m', target: 150 },
        // Ramp down (recovery phase)
        { duration: '1m', target: 0 },
    ],

    thresholds: {
        http_req_duration: ['p(95)<3000'],   // 95% under 3s (more lenient than smoke)
        http_req_failed: ['rate<0.05'],       // Less than 5% failures
        login_duration: ['p(95)<2000'],       // Login specifically under 2s
        api_errors: ['rate<0.1'],             // Less than 10% API errors
    },
};

// ─── Test Scenario ───────────────────────────────────────────────
// Each VU simulates a realistic user session:
// Login → Browse branches → View members → Check stats → Logout

export default function () {
    // ─── Login ───────────────────────────────────────────────────
    const loginStart = Date.now();
    const loginRes = http.post(
        `${BASE_URL}/api/login`,
        JSON.stringify({ username: 'admin', password: 'admin123' }),
        { headers: { 'Content-Type': 'application/json' } }
    );
    loginDuration.add(Date.now() - loginStart);

    const loginOk = check(loginRes, {
        'login: status 200': (r) => r.status === 200,
        'login: has token': (r) => r.status === 200 && r.json().token !== undefined,
    });

    if (!loginOk) {
        apiErrors.add(1);
        sleep(1);
        return; // Skip rest of scenario if login fails
    }

    apiErrors.add(0);
    const token = loginRes.json().token;
    const authHeaders = {
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
    };

    sleep(0.5); // Simulate user thinking time

    // ─── Browse Branches ─────────────────────────────────────────
    const branchesRes = http.get(`${BASE_URL}/api/branches`, authHeaders);
    check(branchesRes, {
        'branches: status 200': (r) => r.status === 200,
    }) || apiErrors.add(1);

    sleep(0.3);

    // ─── View Members (paginated) ────────────────────────────────
    const page = Math.floor(Math.random() * 3) + 1; // Random page 1-3
    const membersRes = http.get(
        `${BASE_URL}/api/members?page=${page}&limit=20`,
        authHeaders
    );
    check(membersRes, {
        'members: status 200': (r) => r.status === 200,
    }) || apiErrors.add(1);

    sleep(0.3);

    // ─── Dashboard Stats ─────────────────────────────────────────
    const statsRes = http.get(`${BASE_URL}/api/stats`, authHeaders);
    check(statsRes, {
        'stats: status 200': (r) => r.status === 200,
        'stats: has data': (r) => r.status === 200 && r.json().total_members !== undefined,
    }) || apiErrors.add(1);

    sleep(0.5);

    // ─── View Members Again (simulates navigation) ───────────────
    const membersRes2 = http.get(
        `${BASE_URL}/api/members?page=1&limit=10`,
        authHeaders
    );
    check(membersRes2, {
        'members page 2: status 200': (r) => r.status === 200,
    }) || apiErrors.add(1);

    // Think time between iterations (simulates real user behavior)
    sleep(Math.random() * 2 + 1); // 1-3 seconds
}
