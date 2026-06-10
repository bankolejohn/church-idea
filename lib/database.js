const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.DB_POOL_MAX) || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

// Log pool errors
pool.on('error', (err) => {
    logger.error('Unexpected database pool error', { error: err.message });
});

// Log pool connection events
pool.on('connect', () => {
    logger.debug('New database connection established');
});

// Health check function
async function isHealthy() {
    try {
        const result = await pool.query('SELECT 1');
        return result.rows.length === 1;
    } catch (error) {
        logger.error('Database health check failed', { error: error.message });
        return false;
    }
}

// Graceful shutdown
async function close() {
    logger.info('Closing database pool...');
    await pool.end();
    logger.info('Database pool closed');
}

module.exports = {
    pool,
    query: (text, params) => pool.query(text, params),
    getClient: () => pool.connect(),
    isHealthy,
    close
};
