-- Add user_metadata table for exclusive status pages
CREATE TABLE IF NOT EXISTS user_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  
  -- Status page fields
  status_title VARCHAR(255),
  status_description TEXT,
  status_links JSONB DEFAULT '[]',
  status_visibility VARCHAR(50) DEFAULT 'private', -- 'private' or 'public'
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for quick lookups
CREATE INDEX idx_user_metadata_user_id ON user_metadata(user_id);
