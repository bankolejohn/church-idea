const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const db = require('./lib/database');
const logger = require('./lib/logger');
const { validateMember, validateBranch, validatePastor, sanitize, validateId } = require('./lib/validation');

const app = express();
const PORT = process.env.PORT || 3000;

// CRITICAL: Fail fast if JWT_SECRET is not set in production
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'change-this-in-production') {
    if (process.env.NODE_ENV === 'production') {
        logger.error('FATAL: JWT_SECRET is not set or using default value. Refusing to start in production.');
        process.exit(1);
    } else {
        logger.warn('JWT_SECRET is not set. Using insecure default for development ONLY.');
    }
}
const SECRET = JWT_SECRET || 'dev-only-insecure-default';

// Trust proxy (for ECS/K8s behind load balancer)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // TODO: Remove unsafe-inline when migrating to bundler
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Stricter rate limit for login
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});

// CORS
const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : null;

app.use(cors({
    origin: allowedOrigins || true,
    credentials: true
}));

// Request parsing with size limit
app.use(express.json({ limit: '1mb' }));

// Attach request ID for tracing
app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
});

// Request logging (exclude health endpoints from logs to reduce noise)
app.use(morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
    skip: (req) => req.url === '/health' || req.url === '/ready'
}));

// Static files
app.use(express.static('public'));

// ──────────────────────────────────────────────
// Health Check Endpoints
// ──────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.get('/ready', async (req, res) => {
    const dbHealthy = await db.isHealthy();

    if (dbHealthy) {
        res.status(200).json({
            status: 'ready',
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } else {
        res.status(503).json({
            status: 'not ready',
            database: 'disconnected',
            timestamp: new Date().toISOString()
        });
    }
});

// ──────────────────────────────────────────────
// Authentication Middleware
// ──────────────────────────────────────────────

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

const requireRole = (roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
};

// ──────────────────────────────────────────────
// Auth Routes
// ──────────────────────────────────────────────

app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    // Input length check
    if (username.length > 100 || password.length > 128) {
        return res.status(400).json({ error: 'Invalid credentials' });
    }

    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(password, user.password))) {
            logger.warn('Failed login attempt', { username, requestId: req.requestId });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, branch_id: user.branch_id },
            SECRET,
            { expiresIn: '24h' }
        );

        let branch_name = null;
        if (user.role === 'branch_pastor' && user.branch_id) {
            const branchResult = await db.query('SELECT name FROM branches WHERE id = $1', [user.branch_id]);
            branch_name = branchResult.rows[0]?.name || 'Unknown Branch';
        }

        logger.info('User logged in', { username: user.username, role: user.role, requestId: req.requestId });

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                branch_id: user.branch_id,
                branch_name
            }
        });
    } catch (error) {
        logger.error('Login error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        let branch_name = null;
        if (req.user.role === 'branch_pastor' && req.user.branch_id) {
            const result = await db.query('SELECT name FROM branches WHERE id = $1', [req.user.branch_id]);
            branch_name = result.rows[0]?.name || 'Unknown Branch';
        }

        res.json({
            user: { ...req.user, branch_name }
        });
    } catch (error) {
        logger.error('Get user error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ──────────────────────────────────────────────
// Branch Routes
// ──────────────────────────────────────────────

app.get('/api/branches', authenticateToken, async (req, res) => {
    try {
        let result;
        if (req.user.role === 'branch_pastor') {
            result = await db.query('SELECT * FROM branches WHERE id = $1', [req.user.branch_id]);
        } else {
            result = await db.query('SELECT * FROM branches ORDER BY name');
        }
        res.json(result.rows);
    } catch (error) {
        logger.error('Get branches error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/branches', authenticateToken, requireRole(['main_leader']), async (req, res) => {
    const errors = validateBranch(req.body);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    const name = sanitize(req.body.name);
    const address = sanitize(req.body.address);
    const pastor_name = sanitize(req.body.pastor_name);

    try {
        const result = await db.query(
            'INSERT INTO branches (name, address, pastor_name) VALUES ($1, $2, $3) RETURNING *',
            [name, address, pastor_name]
        );

        logger.info('Branch created', { branch: result.rows[0].name, requestId: req.requestId });
        res.status(201).json(result.rows[0]);
    } catch (error) {
        logger.error('Create branch error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/branches/:id', authenticateToken, requireRole(['main_leader']), async (req, res) => {
    const branchId = validateId(req.params.id);
    if (!branchId) {
        return res.status(400).json({ error: 'Invalid branch ID' });
    }

    const errors = validateBranch(req.body);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    const name = sanitize(req.body.name);
    const address = sanitize(req.body.address);
    const pastor_name = sanitize(req.body.pastor_name);

    try {
        const result = await db.query(
            'UPDATE branches SET name = $1, address = $2, pastor_name = $3 WHERE id = $4 RETURNING *',
            [name, address, pastor_name, branchId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Branch not found' });
        }

        logger.info('Branch updated', { branchId, requestId: req.requestId });
        res.json(result.rows[0]);
    } catch (error) {
        logger.error('Update branch error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ──────────────────────────────────────────────
// Member Routes
// ──────────────────────────────────────────────

app.get('/api/members', authenticateToken, async (req, res) => {
    try {
        // Pagination
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100));
        const offset = (page - 1) * limit;

        let result;
        if (req.user.role === 'branch_pastor') {
            result = await db.query(
                `SELECT m.*, b.name as branch_name 
                 FROM members m JOIN branches b ON m.branch_id = b.id 
                 WHERE m.branch_id = $1 ORDER BY m.name LIMIT $2 OFFSET $3`,
                [req.user.branch_id, limit, offset]
            );
        } else {
            result = await db.query(
                `SELECT m.*, b.name as branch_name 
                 FROM members m JOIN branches b ON m.branch_id = b.id 
                 ORDER BY m.name LIMIT $1 OFFSET $2`,
                [limit, offset]
            );
        }
        res.json(result.rows);
    } catch (error) {
        logger.error('Get members error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/members', authenticateToken, requireRole(['branch_pastor']), async (req, res) => {
    const errors = validateMember(req.body);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    const { join_date, branch_id, is_worker } = req.body;

    // Pastor can only add to their own branch
    if (req.user.branch_id !== parseInt(branch_id)) {
        return res.status(403).json({ error: 'Can only add members to your own branch' });
    }

    const name = sanitize(req.body.name);
    const address = sanitize(req.body.address);
    const workplace = sanitize(req.body.workplace);
    const occupation = sanitize(req.body.occupation);
    const department = sanitize(req.body.department);
    const phone = sanitize(req.body.phone);
    const email = sanitize(req.body.email);

    try {
        const result = await db.query(
            `INSERT INTO members (name, address, workplace, occupation, join_date, branch_id, is_worker, department, phone, email)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [name, address, workplace, occupation, join_date || null,
             branch_id, is_worker || false, department, phone, email]
        );

        logger.info('Member added', { member: name, branch_id, requestId: req.requestId });
        res.status(201).json(result.rows[0]);
    } catch (error) {
        logger.error('Create member error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/members/:id', authenticateToken, requireRole(['branch_pastor']), async (req, res) => {
    const memberId = validateId(req.params.id);
    if (!memberId) {
        return res.status(400).json({ error: 'Invalid member ID' });
    }

    const errors = validateMember(req.body);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    try {
        // Check ownership
        const existing = await db.query('SELECT branch_id FROM members WHERE id = $1', [memberId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Member not found' });
        }
        if (req.user.branch_id !== existing.rows[0].branch_id) {
            return res.status(403).json({ error: 'Can only edit members from your own branch' });
        }

        const name = sanitize(req.body.name);
        const address = sanitize(req.body.address);
        const workplace = sanitize(req.body.workplace);
        const occupation = sanitize(req.body.occupation);
        const department = sanitize(req.body.department);
        const phone = sanitize(req.body.phone);
        const email = sanitize(req.body.email);
        const { join_date, is_worker } = req.body;

        const result = await db.query(
            `UPDATE members SET name = $1, address = $2, workplace = $3, occupation = $4, 
             join_date = $5, is_worker = $6, department = $7, phone = $8, email = $9, 
             updated_at = CURRENT_TIMESTAMP WHERE id = $10 RETURNING *`,
            [name, address, workplace, occupation,
             join_date || null, is_worker || false, department, phone, email, memberId]
        );

        logger.info('Member updated', { memberId, requestId: req.requestId });
        res.json(result.rows[0]);
    } catch (error) {
        logger.error('Update member error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/members/:id', authenticateToken, requireRole(['branch_pastor']), async (req, res) => {
    const memberId = validateId(req.params.id);
    if (!memberId) {
        return res.status(400).json({ error: 'Invalid member ID' });
    }

    try {
        const existing = await db.query('SELECT branch_id FROM members WHERE id = $1', [memberId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Member not found' });
        }
        if (req.user.branch_id !== existing.rows[0].branch_id) {
            return res.status(403).json({ error: 'Can only delete members from your own branch' });
        }

        await db.query('DELETE FROM members WHERE id = $1', [memberId]);

        logger.info('Member deleted', { memberId, requestId: req.requestId });
        res.json({ message: 'Member deleted successfully' });
    } catch (error) {
        logger.error('Delete member error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ──────────────────────────────────────────────
// Stats / Dashboard Route
// ──────────────────────────────────────────────

app.get('/api/stats', authenticateToken, async (req, res) => {
    try {
        if (req.user.role === 'main_leader') {
            const branchStats = await db.query(`
                SELECT b.id, b.name, b.address, b.pastor_name, COUNT(m.id) as member_count
                FROM branches b LEFT JOIN members m ON b.id = m.branch_id
                GROUP BY b.id ORDER BY b.name
            `);

            const totalMembers = await db.query('SELECT COUNT(*) as total_members FROM members');

            res.json({
                total_members: parseInt(totalMembers.rows[0].total_members),
                total_branches: branchStats.rows.length,
                branches: branchStats.rows.map(b => ({ ...b, member_count: parseInt(b.member_count) }))
            });
        } else {
            const branchStats = await db.query(`
                SELECT b.id, b.name, b.address, b.pastor_name, COUNT(m.id) as member_count
                FROM branches b LEFT JOIN members m ON b.id = m.branch_id
                WHERE b.id = $1 GROUP BY b.id
            `, [req.user.branch_id]);

            res.json({
                total_members: branchStats.rows[0] ? parseInt(branchStats.rows[0].member_count) : 0,
                total_branches: 1,
                branches: branchStats.rows.map(b => ({ ...b, member_count: parseInt(b.member_count) }))
            });
        }
    } catch (error) {
        logger.error('Get stats error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ──────────────────────────────────────────────
// Admin Routes
// ──────────────────────────────────────────────

app.post('/api/create-pastor', authenticateToken, requireRole(['main_leader']), async (req, res) => {
    const errors = validatePastor(req.body);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join(', ') });
    }

    const { username, password, branch_id } = req.body;

    try {
        // Verify branch exists
        const branchCheck = await db.query('SELECT id FROM branches WHERE id = $1', [parseInt(branch_id)]);
        if (branchCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Branch does not exist' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const result = await db.query(
            'INSERT INTO users (username, password, role, branch_id) VALUES ($1, $2, $3, $4) RETURNING id, username, role, branch_id',
            [sanitize(username), hashedPassword, 'branch_pastor', parseInt(branch_id)]
        );

        logger.info('Pastor account created', { username, branch_id, requestId: req.requestId });
        res.status(201).json({ message: 'Pastor account created successfully', user: result.rows[0] });
    } catch (error) {
        if (error.message.includes('unique') || error.message.includes('duplicate')) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        logger.error('Create pastor error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ──────────────────────────────────────────────
// Catch-all: Serve frontend
// ──────────────────────────────────────────────

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ──────────────────────────────────────────────
// Graceful Shutdown
// ──────────────────────────────────────────────

let server;

function startServer() {
    server = app.listen(PORT, '0.0.0.0', () => {
        logger.info('Server started', { port: PORT, env: process.env.NODE_ENV || 'development' });
    });

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

async function gracefulShutdown(signal) {
    logger.info(`${signal} received. Starting graceful shutdown...`);

    server.close(async () => {
        logger.info('HTTP server closed');
        await db.close();
        logger.info('Graceful shutdown complete');
        process.exit(0);
    });

    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
}

// Only start server if this file is run directly (not imported for testing)
if (require.main === module) {
    startServer();
}

module.exports = app;
