/**
 * Monthly Returns API Routes
 *
 * Endpoints:
 * POST   /api/returns/extract    — Upload image, get AI-extracted data
 * POST   /api/returns            — Save a draft (extracted + edited data)
 * PUT    /api/returns/:id        — Update a draft
 * POST   /api/returns/:id/submit — Submit to G.O. for review
 * GET    /api/returns            — List returns (filtered by branch/status)
 * GET    /api/returns/:id        — Get a specific return with entries
 * POST   /api/returns/:id/review — G.O. reviews (approve/reject)
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const db = require('../database');
const logger = require('../logger');
const { extractFromImage } = require('../extraction');

// ──────────────────────────────────────────────
// Helper: Parse short date formats from AI extraction
// Handles: "3/5", "3/5/26", "3/5/2026", "17/5/26", "2026-05-03"
// Returns: "2026-05-03" format for PostgreSQL DATE column
// ──────────────────────────────────────────────
function parseServiceDate(dateStr, monthContext) {
    if (!dateStr) return null;

    // Already in ISO format (2026-05-03)
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

    // Parse "day/month" or "day/month/year" format
    const parts = dateStr.split('/');
    if (parts.length >= 2) {
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10);
        let year;

        if (parts.length === 3) {
            year = parseInt(parts[2], 10);
            if (year < 100) year += 2000; // "26" → 2026
        } else {
            // No year in date — infer from monthContext (e.g., "May 2026" or "2026-05-01")
            year = extractYear(monthContext);
        }

        if (day && month && year) {
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
    }

    // Fallback: return as-is and let PostgreSQL try
    return dateStr;
}

function extractYear(monthContext) {
    if (!monthContext) return new Date().getFullYear();

    // Match "2026" in "May 2026" or "2026-05-01"
    const yearMatch = monthContext.match(/(\d{4})/);
    return yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
}

// Multer config: accept image uploads up to 10MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },  // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    },
});

// ──────────────────────────────────────────────
// POST /api/returns/extract — Upload image & extract data
// ──────────────────────────────────────────────
router.post('/extract', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded' });
    }

    try {
        const imageBase64 = req.file.buffer.toString('base64');
        const mimeType = req.file.mimetype;

        const result = await extractFromImage(imageBase64, mimeType);

        if (!result.success) {
            return res.status(422).json({ error: result.error });
        }

        logger.info('Monthly returns extracted from image', {
            branch_id: req.user.branch_id,
            requestId: req.requestId,
        });

        res.json({
            extracted: result.data,
            tokens_used: result.tokens_used,
            message: 'Data extracted successfully. Please review and correct any errors before saving.',
        });

    } catch (error) {
        logger.error('Extract endpoint error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Failed to process image' });
    }
});

// ──────────────────────────────────────────────
// POST /api/returns — Save draft (create new monthly return)
// ──────────────────────────────────────────────
router.post('/', async (req, res) => {
    const { month, attendance, income, image_base64 } = req.body;

    if (!month || !attendance || !income) {
        return res.status(400).json({ error: 'month, attendance, and income are required' });
    }

    // Pastor can only submit for their own branch
    if (req.user.role === 'branch_pastor' && !req.user.branch_id) {
        return res.status(403).json({ error: 'No branch assigned to your account' });
    }

    const branch_id = req.user.branch_id;

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Create the monthly return record
        const returnResult = await client.query(
            `INSERT INTO monthly_returns (branch_id, submitted_by, month, status)
             VALUES ($1, $2, $3, 'draft') RETURNING id`,
            [branch_id, req.user.id, month]
        );
        const returnId = returnResult.rows[0].id;

        // Insert attendance entries
        for (const entry of attendance) {
            await client.query(
                `INSERT INTO attendance_entries (return_id, service_date, men, women, youth, children, total)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [returnId, parseServiceDate(entry.date, month), entry.men || 0, entry.women || 0,
                 entry.youth || 0, entry.children || 0, entry.total || 0]
            );
        }

        // Insert income entries
        for (const entry of income) {
            await client.query(
                `INSERT INTO income_entries (return_id, service_date, tithe_account, tithe_offering,
                 main_account, sunday_school, evangelism, pure_water, other)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [returnId, parseServiceDate(entry.date, month), entry.tithe_account || 0, entry.tithe_offering || 0,
                 entry.main_account || 0, entry.sunday_school || 0, entry.evangelism || 0,
                 entry.pure_water || 0, entry.other || 0]
            );
        }

        await client.query('COMMIT');

        logger.info('Monthly return draft saved', { returnId, branch_id, month, requestId: req.requestId });

        res.status(201).json({
            id: returnId,
            status: 'draft',
            message: 'Draft saved. Submit when ready for G.O. review.',
        });

    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') {  // Unique violation
            return res.status(409).json({ error: 'A return for this month already exists for your branch' });
        }
        logger.error('Save return error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Failed to save monthly return' });
    } finally {
        client.release();
    }
});

// ──────────────────────────────────────────────
// PUT /api/returns/:id — Update a draft
// ──────────────────────────────────────────────
router.put('/:id', async (req, res) => {
    const returnId = parseInt(req.params.id);
    const { attendance, income } = req.body;

    if (!returnId || isNaN(returnId)) {
        return res.status(400).json({ error: 'Invalid return ID' });
    }

    const client = await db.getClient();
    try {
        // Verify ownership and status
        const existing = await client.query(
            'SELECT * FROM monthly_returns WHERE id = $1 AND submitted_by = $2 AND status = $3',
            [returnId, req.user.id, 'draft']
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Draft not found or not editable' });
        }

        await client.query('BEGIN');

        // Delete old entries and re-insert
        await client.query('DELETE FROM attendance_entries WHERE return_id = $1', [returnId]);
        await client.query('DELETE FROM income_entries WHERE return_id = $1', [returnId]);

        // Re-insert attendance
        if (attendance) {
            for (const entry of attendance) {
                await client.query(
                    `INSERT INTO attendance_entries (return_id, service_date, men, women, youth, children, total)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [returnId, parseServiceDate(entry.date, existing.rows[0].month), entry.men || 0, entry.women || 0,
                     entry.youth || 0, entry.children || 0, entry.total || 0]
                );
            }
        }

        // Re-insert income
        if (income) {
            for (const entry of income) {
                await client.query(
                    `INSERT INTO income_entries (return_id, service_date, tithe_account, tithe_offering,
                     main_account, sunday_school, evangelism, pure_water, other)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [returnId, parseServiceDate(entry.date, existing.rows[0].month), entry.tithe_account || 0, entry.tithe_offering || 0,
                     entry.main_account || 0, entry.sunday_school || 0, entry.evangelism || 0,
                     entry.pure_water || 0, entry.other || 0]
                );
            }
        }

        await client.query('COMMIT');

        logger.info('Monthly return updated', { returnId, requestId: req.requestId });
        res.json({ message: 'Draft updated successfully' });

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Update return error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Failed to update return' });
    } finally {
        client.release();
    }
});

// ──────────────────────────────────────────────
// POST /api/returns/:id/submit — Submit to G.O.
// ──────────────────────────────────────────────
router.post('/:id/submit', async (req, res) => {
    const returnId = parseInt(req.params.id);

    try {
        const result = await db.query(
            `UPDATE monthly_returns
             SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND submitted_by = $2 AND status = 'draft'
             RETURNING *`,
            [returnId, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Draft not found or already submitted' });
        }

        logger.info('Monthly return submitted', { returnId, requestId: req.requestId });
        res.json({ message: 'Monthly return submitted to G.O. for review', status: 'submitted' });

    } catch (error) {
        logger.error('Submit return error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Failed to submit return' });
    }
});

// ──────────────────────────────────────────────
// GET /api/returns — List returns
// ──────────────────────────────────────────────
router.get('/', async (req, res) => {
    const { status } = req.query;

    try {
        let query;
        let params;

        if (req.user.role === 'main_leader') {
            // G.O. sees all branches
            query = `SELECT mr.*, b.name as branch_name, u.username as submitted_by_name
                     FROM monthly_returns mr
                     JOIN branches b ON mr.branch_id = b.id
                     JOIN users u ON mr.submitted_by = u.id
                     ${status ? 'WHERE mr.status = $1' : ''}
                     ORDER BY mr.month DESC, b.name`;
            params = status ? [status] : [];
        } else {
            // Pastor sees only their branch
            query = `SELECT mr.*, b.name as branch_name
                     FROM monthly_returns mr
                     JOIN branches b ON mr.branch_id = b.id
                     WHERE mr.branch_id = $1
                     ${status ? 'AND mr.status = $2' : ''}
                     ORDER BY mr.month DESC`;
            params = status ? [req.user.branch_id, status] : [req.user.branch_id];
        }

        const result = await db.query(query, params);
        res.json(result.rows);

    } catch (error) {
        logger.error('List returns error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Failed to fetch returns' });
    }
});

// ──────────────────────────────────────────────
// GET /api/returns/:id — Get specific return with entries
// ──────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    const returnId = parseInt(req.params.id);

    try {
        const returnResult = await db.query(
            `SELECT mr.*, b.name as branch_name, u.username as submitted_by_name
             FROM monthly_returns mr
             JOIN branches b ON mr.branch_id = b.id
             JOIN users u ON mr.submitted_by = u.id
             WHERE mr.id = $1`,
            [returnId]
        );

        if (returnResult.rows.length === 0) {
            return res.status(404).json({ error: 'Return not found' });
        }

        const monthlyReturn = returnResult.rows[0];

        // Check access (pastor can only see their branch, G.O. can see all)
        if (req.user.role === 'branch_pastor' && monthlyReturn.branch_id !== req.user.branch_id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Get attendance entries
        const attendance = await db.query(
            'SELECT * FROM attendance_entries WHERE return_id = $1 ORDER BY service_date',
            [returnId]
        );

        // Get income entries
        const income = await db.query(
            'SELECT * FROM income_entries WHERE return_id = $1 ORDER BY service_date',
            [returnId]
        );

        res.json({
            ...monthlyReturn,
            attendance: attendance.rows,
            income: income.rows,
        });

    } catch (error) {
        logger.error('Get return error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Failed to fetch return' });
    }
});

// ──────────────────────────────────────────────
// POST /api/returns/:id/review — G.O. reviews
// ──────────────────────────────────────────────
router.post('/:id/review', async (req, res) => {
    if (req.user.role !== 'main_leader') {
        return res.status(403).json({ error: 'Only the G.O. can review returns' });
    }

    const returnId = parseInt(req.params.id);
    const { action, notes } = req.body;  // action: 'approve' or 'reject'

    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be "approve" or "reject"' });
    }

    const newStatus = action === 'approve' ? 'reviewed' : 'rejected';

    try {
        const result = await db.query(
            `UPDATE monthly_returns
             SET status = $1, reviewed_by = $2, review_notes = $3, reviewed_at = CURRENT_TIMESTAMP
             WHERE id = $4 AND status = 'submitted'
             RETURNING *`,
            [newStatus, req.user.id, notes || null, returnId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Return not found or not in submitted status' });
        }

        logger.info('Monthly return reviewed', { returnId, action, requestId: req.requestId });
        res.json({ message: `Return ${action}d successfully`, status: newStatus });

    } catch (error) {
        logger.error('Review return error', { error: error.message, requestId: req.requestId });
        res.status(500).json({ error: 'Failed to review return' });
    }
});

module.exports = router;
