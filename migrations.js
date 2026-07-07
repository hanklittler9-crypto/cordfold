// Runs idempotent SQL migrations on server startup (safe for Render deploys).

const MIGRATIONS = [
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS bg_type VARCHAR(20) DEFAULT 'solid'`,
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS bg_value TEXT`,
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS layout VARCHAR(20) DEFAULT 'centered'`,
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS font_family VARCHAR(80) DEFAULT 'DM Sans'`,
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS card_opacity DOUBLE PRECISION DEFAULT 0.92`,
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS particles_enabled BOOLEAN DEFAULT false`,
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS bg_blur_enabled BOOLEAN DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token VARCHAR(64)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS setup_reminder_sent_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS spotify_enabled BOOLEAN DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS spotify_public BOOLEAN DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS spotify_access_token TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS spotify_refresh_token TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS spotify_token_expires_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_links JSONB DEFAULT '[]'::jsonb`,
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS entry_splash BOOLEAN DEFAULT false`,
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS typewriter_bio BOOLEAN DEFAULT false`,
  `ALTER TABLE themes ADD COLUMN IF NOT EXISTS tilt_card BOOLEAN DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_status VARCHAR(10)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_activity TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_updated_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_options JSONB DEFAULT '{}'::jsonb`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_role_alerts BOOLEAN DEFAULT true`,
];

async function runMigrations(db) {
  for (const sql of MIGRATIONS) {
    try {
      await db.query(sql);
    } catch (err) {
      console.error('[migrate] Failed:', sql.slice(0, 60), err.message);
      throw err;
    }
  }
  console.log('[migrate] Database migrations applied');
}

module.exports = { runMigrations };
