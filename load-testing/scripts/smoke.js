/**
 * k6 Smoke Test
 * ────────────────────────────────────────────────────────────────────
 *
 * PURPOSE:
 * A minimal load test that verifies the system works under light load.
 * Run this FIRST after every deploy to confirm nothing is broken.
 *
 * WHAT IT DOES:
 * - 1 virtual user (VU)
 * - Runs for 30 seconds
 * - Hits health, login, and core endpoints
 * - If anything fails, the test fails (exit code 1)
 *
 * WHEN TO USE:
 * - After deploying to staging
 * - As a CI step post-deploy
 * - Quick sanity check before heavier load tests
 *
 * USAGE:
 *   k6 run load-testing/scripts/smoke.js
 *   k6 run --env BASE_URL=https://staging.example.com load-testing/scripts/smoke.js
 *
 * ────────────────────────────────────────────────────────────────────
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

// ─── Configuration ───────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
    vus: 1,
    duration: '30s',

    // Thresholds: if these fail, the test exits with code 1
    thresholds: {
        http_req_duration: ['p(95)<2000'],  // 95% of requests under 2s
        http_req_failed: ['rate<0.01'],      // Less than 1% failures
    },
};

// ─── Test Scenario ───────────────────────────────────────────────
export default function () {
    // 1. Health check
    const healthRes = http.get(`${BASE_URL}/health`);
    check(healthRes, {
        'health: status 200': (r) => r.status === 200,
        'health: returns ok': (r) => r.json().status === 'ok',
    });

    // 2. Readiness check
    const readyRes = http.get(`${BASE_URL}/ready`);
    check(readyRes, {
        'ready: status 200': (r) => r.status === 200,
        'ready: database connected': (r) => r.json().database === 'connected',
    });

    // 3. Login
    const loginRes = http.post(
        `${BASE_URL}/api/login`,
        JSON.stringify({ username: 'admin', password: 'admin123' }),
        { headers: { 'Content-Type': 'application/json' } }
    );
    check(loginRes, {
        'login: status 200': (r) => r.status === 200,
        'login: token received': (r) => r.json().token !== undefined,
    });

    if (loginRes.status === 200) {
        const token = loginRes.json().token;
        const authHeaders = {
            headers: { Authorization: `Bearer ${token}` },
        };

        // 4. Get branches
        const branchesRes = http.get(`${BASE_URL}/api/branches`, authHeaders);
        check(branchesRes, {
            'branches: status 200': (r) => r.status === 200,
            'branches: returns array': (r) => Array.isArray(r.json()),
        });

        // 5. Get members
        const membersRes = http.get(`${BASE_URL}/api/members?page=1&limit=10`, authHeaders);
        check(membersRes, {
            'members: status 200': (r) => r.status === 200,
        });

        // 6. Get stats
        const statsRes = http.get(`${BASE_URL}/api/stats`, authHeaders);
        check(statsRes, {
            'stats: status 200': (r) => r.status === 200,
            'stats: has total_members': (r) => r.json().total_members !== undefined,
        });
    }

    sleep(1);
}
