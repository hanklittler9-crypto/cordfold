require('dotenv').config();
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigration() {
  try {
    console.log('Running migration: user_metadata table...');
    
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_metadata (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        
        -- Status page fields
        status_title VARCHAR(255),
        status_description TEXT,
        status_links JSONB DEFAULT '[]',
        status_visibility VARCHAR(50) DEFAULT 'private',
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_user_metadata_user_id ON user_metadata(user_id);
    `);
    
    console.log('✓ Migration completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('✗ Migration failed:', err.message);
    process.exit(1);
  }
}

runMigration();
