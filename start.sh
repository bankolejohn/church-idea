#!/bin/sh
# Render startup script: run migrations, seed, then start server
# Migrations are idempotent (skip already-applied ones)
# Seed is idempotent (skips if admin already exists)

echo "Running database migrations..."
node db/migrate.js

echo "Seeding database..."
node db/seed.js

echo "Starting server..."
node server.js
