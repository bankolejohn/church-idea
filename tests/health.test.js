const request = require('supertest');

// Mock the database module before requiring the app
jest.mock('../lib/database', () => ({
    query: jest.fn(),
    isHealthy: jest.fn(),
    close: jest.fn()
}));

const app = require('../server');
const db = require('../lib/database');

describe('Health Endpoints', () => {
    test('GET /health returns 200 with status ok', async () => {
        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.timestamp).toBeDefined();
        expect(res.body.uptime).toBeDefined();
    });

    test('GET /ready returns 200 when database is healthy', async () => {
        db.isHealthy.mockResolvedValue(true);

        const res = await request(app).get('/ready');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ready');
        expect(res.body.database).toBe('connected');
    });

    test('GET /ready returns 503 when database is down', async () => {
        db.isHealthy.mockResolvedValue(false);

        const res = await request(app).get('/ready');

        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not ready');
        expect(res.body.database).toBe('disconnected');
    });
});

describe('Security Headers', () => {
    test('includes X-Request-Id header', async () => {
        const res = await request(app).get('/health');
        expect(res.headers['x-request-id']).toBeDefined();
    });

    test('includes security headers from Helmet', async () => {
        const res = await request(app).get('/health');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    });

    test('forwards existing X-Request-Id', async () => {
        const customId = 'test-request-123';
        const res = await request(app)
            .get('/health')
            .set('X-Request-Id', customId);

        expect(res.headers['x-request-id']).toBe(customId);
    });
});

describe('Authentication', () => {
    test('returns 401 for unauthenticated API requests', async () => {
        const res = await request(app).get('/api/branches');
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Access token required');
    });

    test('returns 403 for invalid token', async () => {
        const res = await request(app)
            .get('/api/branches')
            .set('Authorization', 'Bearer invalid-token');

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Invalid or expired token');
    });

    test('returns 400 for login without credentials', async () => {
        const res = await request(app)
            .post('/api/login')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Username and password are required');
    });
});

describe('Input Validation', () => {
    test('rejects invalid member ID in URL', async () => {
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { id: 1, username: 'admin', role: 'branch_pastor', branch_id: 1 },
            process.env.JWT_SECRET || 'dev-only-insecure-default',
            { expiresIn: '1h' }
        );

        const res = await request(app)
            .put('/api/members/abc')
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'Test' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid member ID');
    });

    test('rejects invalid branch ID in URL', async () => {
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { id: 1, username: 'admin', role: 'main_leader', branch_id: null },
            process.env.JWT_SECRET || 'dev-only-insecure-default',
            { expiresIn: '1h' }
        );

        const res = await request(app)
            .put('/api/branches/abc')
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'Test' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid branch ID');
    });
});
