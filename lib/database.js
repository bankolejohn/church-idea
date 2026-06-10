const { Pool } = require('pg');
const logger = require('./logger');

// Build SSL config properly
function getSslConfig() {
    if (process.env.DB_SSL !== 'true') return false;

    // In production, verify certificates
    if (process.env.NODE_ENV === 'production') {
        return {
            rejectUnauthorized: true,
            ca: process.env.DB_CA_CERT || undefined
        };
    }

    // In non-production, allow self-signed certs
    return { rejectUnauthorized: false };
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: getSslConfig(),
    max: parseInt(process.env.DB_POOL_MAX) || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
    logger.error('Unexpected database pool error', { error: err.message });
});

pool.on('connect', () => {
    logger.debug('New database connection established');
});

async function isHealthy() {
    try {
        const result = await pool.query('SELECT 1');
        return result.rows.length === 1;
    } catch (error) {
        logger.error('Database health check failed', { error: error.message });
        return false;
    }
}

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
