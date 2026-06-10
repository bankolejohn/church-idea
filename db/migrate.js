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

            CREATE TABLE IF NOT EXISTS migrations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `
    }
];

async function migrate() {
    const client = await pool.connect();
    
    try {
        // Create migrations table if it doesn't exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS migrations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Get applied migrations
        const result = await client.query('SELECT name FROM migrations');
        const applied = result.rows.map(r => r.name);

        // Run pending migrations
        for (const migration of migrations) {
            if (!applied.includes(migration.name)) {
                console.log(`Running migration: ${migration.name}`);
                await client.query(migration.up);
                await client.query('INSERT INTO migrations (name) VALUES ($1)', [migration.name]);
                console.log(`Completed: ${migration.name}`);
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
