require('dotenv').config();
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigration() {
  try {
    console.log('Running migration: add Spotify fields...');
    
    // Add Spotify fields to users table if they don't exist
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS spotify_enabled BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS spotify_access_token TEXT,
      ADD COLUMN IF NOT EXISTS spotify_refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS spotify_token_expires_at TIMESTAMP;
    `);
    
    console.log('✓ Spotify migration completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('✗ Migration failed:', err.message);
    process.exit(1);
  }
}

runMigration();
