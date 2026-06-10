const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const db = require('./lib/database');
const logger = require('./lib/logger');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';

// Trust proxy (for ECS/K8s behind load balancer)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow inline scripts for now
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per window
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
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));

// Request parsing
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use(morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) }
}));

// Static files
app.use(express.static('public'));

// ──────────────────────────────────────────────
// Health Check Endpoints
// ──────────────────────────────────────────────

// Liveness probe: "Is the process alive?"
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Readiness probe: "Can it serve traffic?"
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

    jwt.verify(token, JWT_SECRET, (err, user) => {
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

    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (!user || !bcrypt.compareSync(password, user.password)) {
            logger.warn('Failed login attempt', { username });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, branch_id: user.branch_id },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Get branch name for branch pastors
        let branch_name = null;
        if (user.role === 'branch_pastor' && user.branch_id) {
            const branchResult = await db.query('SELECT name FROM branches WHERE id = $1', [user.branch_id]);
            branch_name = branchResult.rows[0]?.name || 'Unknown Branch';
        }

        logger.info('User logged in', { username: user.username, role: user.role });

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
        logger.error('Login error', { error: error.message });
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
        logger.error('Get user error', { error: error.message });
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
        logger.error('Get branches error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/branches', authenticateToken, requireRole(['main_leader']), async (req, res) => {
    const { name, address, pastor_name } = req.body;

    if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: 'Branch name is required' });
    }

    try {
        const result = await db.query(
            'INSERT INTO branches (name, address, pastor_name) VALUES ($1, $2, $3) RETURNING *',
            [name.trim(), address?.trim(), pastor_name?.trim()]
        );

        logger.info('Branch created', { branch: result.rows[0].name });
        res.status(201).json(result.rows[0]);
    } catch (error) {
        logger.error('Create branch error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/branches/:id', authenticateToken, requireRole(['main_leader']), async (req, res) => {
    const { name, address, pastor_name } = req.body;
    const branchId = parseInt(req.params.id);

    if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: 'Branch name is required' });
    }

    try {
        const result = await db.query(
            'UPDATE branches SET name = $1, address = $2, pastor_name = $3 WHERE id = $4 RETURNING *',
            [name.trim(), address?.trim(), pastor_name?.trim(), branchId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Branch not found' });
        }

        logger.info('Branch updated', { branchId });
        res.json(result.rows[0]);
    } catch (error) {
        logger.error('Update branch error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ──────────────────────────────────────────────
// Member Routes
// ──────────────────────────────────────────────

app.get('/api/members', authenticateToken, async (req, res) => {
    try {
        let result;
        if (req.user.role === 'branch_pastor') {
            result = await db.query(
                `SELECT m.*, b.name as branch_name 
                 FROM members m JOIN branches b ON m.branch_id = b.id 
                 WHERE m.branch_id = $1 ORDER BY m.name`,
                [req.user.branch_id]
            );
        } else {
            result = await db.query(
                `SELECT m.*, b.name as branch_name 
                 FROM members m JOIN branches b ON m.branch_id = b.id 
                 ORDER BY m.name`
            );
        }
        res.json(result.rows);
    } catch (error) {
        logger.error('Get members error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/members', authenticateToken, requireRole(['branch_pastor']), async (req, res) => {
    const { name, address, workplace, occupation, join_date, branch_id, is_worker, department, phone, email } = req.body;

    if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: 'Member name is required' });
    }

    // Pastor can only add to their own branch
    if (req.user.branch_id !== parseInt(branch_id)) {
        return res.status(403).json({ error: 'Can only add members to your own branch' });
    }

    try {
        const result = await db.query(
            `INSERT INTO members (name, address, workplace, occupation, join_date, branch_id, is_worker, department, phone, email)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [name.trim(), address?.trim(), workplace?.trim(), occupation?.trim(), join_date || null, 
             branch_id, is_worker || false, department?.trim(), phone?.trim(), email?.trim()]
        );

        logger.info('Member added', { member: name, branch_id });
        res.status(201).json(result.rows[0]);
    } catch (error) {
        logger.error('Create member error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/members/:id', authenticateToken, requireRole(['branch_pastor']), async (req, res) => {
    const memberId = parseInt(req.params.id);
    const { name, address, workplace, occupation, join_date, is_worker, department, phone, email } = req.body;

    try {
        // Check ownership
        const existing = await db.query('SELECT branch_id FROM members WHERE id = $1', [memberId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Member not found' });
        }
        if (req.user.branch_id !== existing.rows[0].branch_id) {
            return res.status(403).json({ error: 'Can only edit members from your own branch' });
        }

        const result = await db.query(
            `UPDATE members SET name = $1, address = $2, workplace = $3, occupation = $4, 
             join_date = $5, is_worker = $6, department = $7, phone = $8, email = $9, 
             updated_at = CURRENT_TIMESTAMP WHERE id = $10 RETURNING *`,
            [name?.trim(), address?.trim(), workplace?.trim(), occupation?.trim(), 
             join_date || null, is_worker || false, department?.trim(), phone?.trim(), email?.trim(), memberId]
        );

        logger.info('Member updated', { memberId });
        res.json(result.rows[0]);
    } catch (error) {
        logger.error('Update member error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/members/:id', authenticateToken, requireRole(['branch_pastor']), async (req, res) => {
    const memberId = parseInt(req.params.id);

    try {
        // Check ownership
        const existing = await db.query('SELECT branch_id FROM members WHERE id = $1', [memberId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Member not found' });
        }
        if (req.user.branch_id !== existing.rows[0].branch_id) {
            return res.status(403).json({ error: 'Can only delete members from your own branch' });
        }

        await db.query('DELETE FROM members WHERE id = $1', [memberId]);
        
        logger.info('Member deleted', { memberId });
        res.json({ message: 'Member deleted successfully' });
    } catch (error) {
        logger.error('Delete member error', { error: error.message });
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
        logger.error('Get stats error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ──────────────────────────────────────────────
// Admin Routes
// ──────────────────────────────────────────────

app.post('/api/create-pastor', authenticateToken, requireRole(['main_leader']), async (req, res) => {
    const { username, password, branch_id } = req.body;

    if (!username || !password || !branch_id) {
        return res.status(400).json({ error: 'Username, password, and branch are required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const hashedPassword = bcrypt.hashSync(password, 10);
        const result = await db.query(
            'INSERT INTO users (username, password, role, branch_id) VALUES ($1, $2, $3, $4) RETURNING id, username, role, branch_id',
            [username.trim(), hashedPassword, 'branch_pastor', parseInt(branch_id)]
        );

        logger.info('Pastor account created', { username, branch_id });
        res.status(201).json({ message: 'Pastor account created successfully', user: result.rows[0] });
    } catch (error) {
        if (error.message.includes('unique') || error.message.includes('duplicate')) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        logger.error('Create pastor error', { error: error.message });
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
        logger.info(`Server started`, { port: PORT, env: process.env.NODE_ENV || 'development' });
    });

    // Handle graceful shutdown (SIGTERM from ECS/K8s)
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
}

async function gracefulShutdown(signal) {
    logger.info(`${signal} received. Starting graceful shutdown...`);

    // Stop accepting new connections
    server.close(async () => {
        logger.info('HTTP server closed');

        // Close database connections
        await db.close();

        logger.info('Graceful shutdown complete');
        process.exit(0);
    });

    // Force shutdown after 30 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
}

startServer();

module.exports = app; // Export for testing
