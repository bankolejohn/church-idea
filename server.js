const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Render deployment
app.set('trust proxy', 1);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('church.db');

// Initialize database tables
db.serialize(() => {
    // Users table (pastors and main leader)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('main_leader', 'branch_pastor')),
        branch_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (branch_id) REFERENCES branches (id)
    )`);

    // Branches table
    db.run(`CREATE TABLE IF NOT EXISTS branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT,
        pastor_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Members table
    db.run(`CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT,
        workplace TEXT,
        occupation TEXT,
        join_date DATE,
        branch_id INTEGER NOT NULL,
        is_worker BOOLEAN DEFAULT 0,
        department TEXT,
        phone TEXT,
        email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (branch_id) REFERENCES branches (id)
    )`);

    // Create default main leader account
    const defaultPassword = bcrypt.hashSync('admin123', 10);
    db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)`, 
        ['admin', defaultPassword, 'main_leader']);
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Role-based access middleware
const requireRole = (roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
};

// Branch access middleware (pastors can only access their own branch)
const checkBranchAccess = (req, res, next) => {
    if (req.user.role === 'main_leader') {
        return next(); // Main leader can access all branches
    }
    
    const branchId = req.params.branchId || req.body.branch_id;
    if (req.user.branch_id && parseInt(branchId) !== req.user.branch_id) {
        return res.status(403).json({ error: 'Access denied to this branch' });
    }
    next();
};

// Routes

// Authentication
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { 
                id: user.id, 
                username: user.username, 
                role: user.role, 
                branch_id: user.branch_id 
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Get branch name for branch pastors
        if (user.role === 'branch_pastor' && user.branch_id) {
            db.get('SELECT name FROM branches WHERE id = ?', [user.branch_id], (err, branch) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }
                
                res.json({
                    token,
                    user: {
                        id: user.id,
                        username: user.username,
                        role: user.role,
                        branch_id: user.branch_id,
                        branch_name: branch ? branch.name : 'Unknown Branch'
                    }
                });
            });
        } else {
            res.json({
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    branch_id: user.branch_id
                }
            });
        }
    });
});

// Get current user info
app.get('/api/me', authenticateToken, (req, res) => {
    if (req.user.role === 'branch_pastor' && req.user.branch_id) {
        // Get branch information for branch pastors
        db.get('SELECT name FROM branches WHERE id = ?', [req.user.branch_id], (err, branch) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            res.json({ 
                user: {
                    ...req.user,
                    branch_name: branch ? branch.name : 'Unknown Branch'
                }
            });
        });
    } else {
        res.json({ user: req.user });
    }
});

// Branches routes
app.get('/api/branches', authenticateToken, (req, res) => {
    let query = 'SELECT * FROM branches';
    let params = [];

    // Branch pastors can only see their own branch
    if (req.user.role === 'branch_pastor') {
        query += ' WHERE id = ?';
        params = [req.user.branch_id];
    }

    db.all(query, params, (err, branches) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(branches);
    });
});

app.post('/api/branches', authenticateToken, requireRole(['main_leader']), (req, res) => {
    const { name, address, pastor_name } = req.body;

    db.run('INSERT INTO branches (name, address, pastor_name) VALUES (?, ?, ?)',
        [name, address, pastor_name], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ id: this.lastID, name, address, pastor_name });
    });
});

app.put('/api/branches/:id', authenticateToken, requireRole(['main_leader']), (req, res) => {
    const { name, address, pastor_name } = req.body;
    const branchId = req.params.id;

    db.run('UPDATE branches SET name = ?, address = ?, pastor_name = ? WHERE id = ?',
        [name, address, pastor_name, branchId], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ message: 'Branch updated successfully' });
    });
});

// Members routes
app.get('/api/members', authenticateToken, (req, res) => {
    let query = `
        SELECT m.*, b.name as branch_name 
        FROM members m 
        JOIN branches b ON m.branch_id = b.id
    `;
    let params = [];

    // Branch pastors can only see their own branch members
    if (req.user.role === 'branch_pastor') {
        query += ' WHERE m.branch_id = ?';
        params = [req.user.branch_id];
    }

    db.all(query, params, (err, members) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(members);
    });
});

app.post('/api/members', authenticateToken, requireRole(['branch_pastor']), (req, res) => {
    const {
        name, address, workplace, occupation, join_date,
        branch_id, is_worker, department, phone, email
    } = req.body;

    // Ensure pastor can only add members to their own branch
    if (req.user.branch_id !== parseInt(branch_id)) {
        return res.status(403).json({ error: 'Can only add members to your own branch' });
    }

    db.run(`INSERT INTO members 
        (name, address, workplace, occupation, join_date, branch_id, is_worker, department, phone, email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, address, workplace, occupation, join_date, branch_id, is_worker, department, phone, email],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ 
                id: this.lastID, 
                name, address, workplace, occupation, join_date,
                branch_id, is_worker, department, phone, email
            });
        }
    );
});

app.put('/api/members/:id', authenticateToken, requireRole(['branch_pastor']), (req, res) => {
    const memberId = req.params.id;
    const {
        name, address, workplace, occupation, join_date,
        is_worker, department, phone, email
    } = req.body;

    // First check if member belongs to pastor's branch
    db.get('SELECT branch_id FROM members WHERE id = ?', [memberId], (err, member) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        if (req.user.branch_id !== member.branch_id) {
            return res.status(403).json({ error: 'Can only edit members from your own branch' });
        }

        db.run(`UPDATE members SET 
            name = ?, address = ?, workplace = ?, occupation = ?, join_date = ?,
            is_worker = ?, department = ?, phone = ?, email = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
            [name, address, workplace, occupation, join_date, is_worker, department, phone, email, memberId],
            function(err) {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }
                res.json({ message: 'Member updated successfully' });
            }
        );
    });
});

app.delete('/api/members/:id', authenticateToken, requireRole(['branch_pastor']), (req, res) => {
    const memberId = req.params.id;

    // First check if member belongs to pastor's branch
    db.get('SELECT branch_id FROM members WHERE id = ?', [memberId], (err, member) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        if (req.user.branch_id !== member.branch_id) {
            return res.status(403).json({ error: 'Can only delete members from your own branch' });
        }

        db.run('DELETE FROM members WHERE id = ?', [memberId], function(err) {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ message: 'Member deleted successfully' });
        });
    });
});

// Dashboard stats
app.get('/api/stats', authenticateToken, (req, res) => {
    if (req.user.role === 'main_leader') {
        // Main leader sees all stats
        db.all(`
            SELECT 
                b.id, b.name, b.address, b.pastor_name,
                COUNT(m.id) as member_count
            FROM branches b
            LEFT JOIN members m ON b.id = m.branch_id
            GROUP BY b.id
        `, (err, branchStats) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            db.get('SELECT COUNT(*) as total_members FROM members', (err, memberCount) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }

                res.json({
                    total_members: memberCount.total_members,
                    total_branches: branchStats.length,
                    branches: branchStats
                });
            });
        });
    } else {
        // Branch pastor sees only their branch stats
        db.get(`
            SELECT 
                b.id, b.name, b.address, b.pastor_name,
                COUNT(m.id) as member_count
            FROM branches b
            LEFT JOIN members m ON b.id = m.branch_id
            WHERE b.id = ?
            GROUP BY b.id
        `, [req.user.branch_id], (err, branchStats) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            res.json({
                total_members: branchStats ? branchStats.member_count : 0,
                total_branches: 1,
                branches: branchStats ? [branchStats] : []
            });
        });
    }
});

// Create branch pastor account (main leader only)
app.post('/api/create-pastor', authenticateToken, requireRole(['main_leader']), (req, res) => {
    const { username, password, branch_id } = req.body;

    const hashedPassword = bcrypt.hashSync(password, 10);

    db.run('INSERT INTO users (username, password, role, branch_id) VALUES (?, ?, ?, ?)',
        [username, hashedPassword, 'branch_pastor', branch_id], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ error: 'Username already exists' });
            }
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ message: 'Pastor account created successfully', id: this.lastID });
    });
});

// Serve the frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Default admin login: username: admin, password: admin123`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});