const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function seed() {
    const client = await pool.connect();

    try {
        // Check if admin already exists
        const existing = await client.query('SELECT id FROM users WHERE username = $1', ['admin']);
        
        if (existing.rows.length > 0) {
            console.log('Admin user already exists. Skipping seed.');
            return;
        }

        // Create default admin
        const hashedPassword = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
        await client.query(
            'INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
            ['admin', hashedPassword, 'main_leader']
        );

        console.log('Seed complete: admin user created.');
        console.log('Username: admin');
        console.log('Password: (from ADMIN_PASSWORD env var or default: admin123)');
    } catch (error) {
        console.error('Seed failed:', error.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

seed();
