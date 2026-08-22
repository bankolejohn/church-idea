const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

const migrations = [
    {
        name: '001_create_tables',
        up: `
            CREATE TABLE IF NOT EXISTS branches (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                address TEXT,
                pastor_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL CHECK(role IN ('main_leader', 'branch_pastor')),
                branch_id INTEGER REFERENCES branches(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS members (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                address TEXT,
                workplace VARCHAR(255),
                occupation VARCHAR(255),
                join_date DATE,
                branch_id INTEGER NOT NULL REFERENCES branches(id),
                is_worker BOOLEAN DEFAULT FALSE,
                department VARCHAR(255),
                phone VARCHAR(50),
                email VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_members_branch_id ON members(branch_id);
            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        `
    },
    {
        name: '002_monthly_returns',
        up: `
            -- Monthly returns: one submission per month per branch
            CREATE TABLE IF NOT EXISTS monthly_returns (
                id SERIAL PRIMARY KEY,
                branch_id INTEGER NOT NULL REFERENCES branches(id),
                submitted_by INTEGER NOT NULL REFERENCES users(id),
                month DATE NOT NULL,
                image_url TEXT,
                status VARCHAR(20) DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'reviewed', 'rejected')),
                review_notes TEXT,
                reviewed_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                submitted_at TIMESTAMP,
                reviewed_at TIMESTAMP,
                UNIQUE(branch_id, month)
            );

            -- Weekly attendance entries (one row per Sunday service)
            CREATE TABLE IF NOT EXISTS attendance_entries (
                id SERIAL PRIMARY KEY,
                return_id INTEGER NOT NULL REFERENCES monthly_returns(id) ON DELETE CASCADE,
                service_date DATE NOT NULL,
                men INTEGER DEFAULT 0,
                women INTEGER DEFAULT 0,
                youth INTEGER DEFAULT 0,
                children INTEGER DEFAULT 0,
                total INTEGER DEFAULT 0
            );

            -- Weekly income entries (one row per Sunday service)
            CREATE TABLE IF NOT EXISTS income_entries (
                id SERIAL PRIMARY KEY,
                return_id INTEGER NOT NULL REFERENCES monthly_returns(id) ON DELETE CASCADE,
                service_date DATE NOT NULL,
                tithe_account DECIMAL(12,2) DEFAULT 0,
                tithe_offering DECIMAL(12,2) DEFAULT 0,
                main_account DECIMAL(12,2) DEFAULT 0,
                sunday_school DECIMAL(12,2) DEFAULT 0,
                evangelism DECIMAL(12,2) DEFAULT 0,
                pure_water DECIMAL(12,2) DEFAULT 0,
                other DECIMAL(12,2) DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_monthly_returns_branch ON monthly_returns(branch_id);
            CREATE INDEX IF NOT EXISTS idx_monthly_returns_status ON monthly_returns(status);
            CREATE INDEX IF NOT EXISTS idx_attendance_return ON attendance_entries(return_id);
            CREATE INDEX IF NOT EXISTS idx_income_return ON income_entries(return_id);
        `
    }
];

async function migrate() {
    const client = await pool.connect();

    try {
        // Create migrations tracking table
        await client.query(`
            CREATE TABLE IF NOT EXISTS migrations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) UNIQUE NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Get already-applied migrations
        const result = await client.query('SELECT name FROM migrations');
        const applied = new Set(result.rows.map(r => r.name));

        // Run pending migrations in order
        for (const migration of migrations) {
            if (!applied.has(migration.name)) {
                console.log(`Running migration: ${migration.name}`);
                await client.query('BEGIN');
                try {
                    await client.query(migration.up);
                    await client.query('INSERT INTO migrations (name) VALUES ($1)', [migration.name]);
                    await client.query('COMMIT');
                    console.log(`Completed: ${migration.name}`);
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                }
            } else {
                console.log(`Skipped (already applied): ${migration.name}`);
            }
        }

        console.log('All migrations complete.');
    } catch (error) {
        console.error('Migration failed:', error.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
