// ─────────────────────────────────────────────────────────────────────────────
// Cordfol.io — Admin Dashboard & Customization (admin.js)
// Only accessible to: gfxasto
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const { Pool } = require('pg');
const router = express.Router();

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ADMIN_USERNAME = 'gfxastro.';

// ── Admin Auth Middleware ────────────────────────────────────────────────────
async function checkAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const result = await db.query(
      'SELECT discord_username FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (result.rowCount === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    if (user.discord_username !== ADMIN_USERNAME) {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    next();
  } catch (err) {
    console.error('[admin] Auth check error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ── Create System Config table if missing ────────────────────────────────────
async function ensureConfigTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        id SERIAL PRIMARY KEY,
        config_key VARCHAR(255) UNIQUE NOT NULL,
        config_value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (err) {
    console.error('[admin] Config table creation error:', err);
  }
}

// ── Get Admin Dashboard Data ─────────────────────────────────────────────────
router.get('/dashboard', checkAdmin, async (req, res) => {
  try {
    await ensureConfigTable();

    // Get total users
    const usersCount = await db.query('SELECT COUNT(*) as count FROM users');
    
    // Get total verified roles
    const rolesCount = await db.query('SELECT COUNT(*) as count FROM verified_roles');
    
    // Get system config
    const configResult = await db.query('SELECT * FROM system_config');
    const config = {};
    configResult.rows.forEach(row => {
      config[row.config_key] = row.config_value;
    });

    // Get status history
    const statusHistory = await db.query(`
      SELECT * FROM system_status 
      ORDER BY created_at DESC 
      LIMIT 48
    `).catch(() => ({ rows: [] }));

    res.json({
      stats: {
        totalUsers: parseInt(usersCount.rows[0].count),
        totalVerifiedRoles: parseInt(rolesCount.rows[0].count),
      },
      config: config || {
        siteName: 'Cordfol.io',
        announcement: '',
        maintenanceMode: 'false',
        statusPageTitle: 'System Status',
      },
      statusHistory: statusHistory.rows,
    });
  } catch (err) {
    console.error('[admin] Dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// ── Update Config ────────────────────────────────────────────────────────────
router.post('/config', checkAdmin, async (req, res) => {
  const { key, value } = req.body;

  if (!key || value === undefined) {
    return res.status(400).json({ error: 'Missing key or value' });
  }

  try {
    await ensureConfigTable();

    await db.query(`
      INSERT INTO system_config (config_key, config_value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (config_key) DO UPDATE
      SET config_value = $2, updated_at = NOW()
    `, [key, String(value)]);

    res.json({ success: true, message: `Config updated: ${key}` });
  } catch (err) {
    console.error('[admin] Config update error:', err);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ── Broadcast Announcement ────────────────────────────────────────────────────
router.post('/announcement', checkAdmin, async (req, res) => {
  const { message, type } = req.body; // type: 'info' | 'warning' | 'error' | 'success'

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    await ensureConfigTable();

    await db.query(`
      INSERT INTO system_config (config_key, config_value, updated_at)
      VALUES ('announcement_' || NOW()::text, $1, NOW())
    `, [JSON.stringify({ message, type, timestamp: new Date().toISOString() })]);

    res.json({ success: true, message: 'Announcement broadcast' });
  } catch (err) {
    console.error('[admin] Announcement error:', err);
    res.status(500).json({ error: 'Failed to post announcement' });
  }
});

// ── Toggle Maintenance Mode ──────────────────────────────────────────────────
router.post('/maintenance', checkAdmin, async (req, res) => {
  const { enabled } = req.body;

  try {
    await ensureConfigTable();

    await db.query(`
      INSERT INTO system_config (config_key, config_value, updated_at)
      VALUES ('maintenanceMode', $1, NOW())
      ON CONFLICT (config_key) DO UPDATE
      SET config_value = $1, updated_at = NOW()
    `, [String(enabled)]);

    res.json({ 
      success: true, 
      message: enabled ? 'Maintenance mode enabled' : 'Maintenance mode disabled' 
    });
  } catch (err) {
    console.error('[admin] Maintenance error:', err);
    res.status(500).json({ error: 'Failed to toggle maintenance mode' });
  }
});

// ── Record System Status ─────────────────────────────────────────────────────
router.post('/status', checkAdmin, async (req, res) => {
  const { service, status, message } = req.body;

  if (!service || !status) {
    return res.status(400).json({ error: 'Missing service or status' });
  }

  try {
    // Create table if needed
    await db.query(`
      CREATE TABLE IF NOT EXISTS system_status (
        id SERIAL PRIMARY KEY,
        service VARCHAR(100),
        status VARCHAR(50),
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `).catch(() => {});

    await db.query(`
      INSERT INTO system_status (service, status, message, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [service, status, message || '']);

    res.json({ success: true, message: 'Status recorded' });
  } catch (err) {
    console.error('[admin] Status recording error:', err);
    res.status(500).json({ error: 'Failed to record status' });
  }
});

// ── Get Current System Status ────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    // Get latest status for each service
    const statusResult = await db.query(`
      SELECT DISTINCT ON (service) service, status, message, created_at
      FROM system_status
      ORDER BY service, created_at DESC
    `).catch(() => ({ rows: [] }));

    // Calculate uptime
    const allStatus = statusResult.rows;
    let uptime = 100;

    if (allStatus.length > 0) {
      const failedCount = allStatus.filter(s => s.status === 'degraded' || s.status === 'down').length;
      uptime = Math.round(((allStatus.length - failedCount) / allStatus.length) * 100);
    }

    res.json({
      timestamp: new Date().toISOString(),
      uptime: uptime,
      services: allStatus.map(s => ({
        name: s.service,
        status: s.status, // 'operational' | 'degraded' | 'down'
        message: s.message,
        lastUpdated: s.created_at,
      })),
    });
  } catch (err) {
    console.error('[admin] Status fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ── Get Config ───────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    await ensureConfigTable();

    const result = await db.query('SELECT config_key, config_value FROM system_config');
    const config = {};
    
    result.rows.forEach(row => {
      config[row.config_key] = row.config_value;
    });

    res.json(config);
  } catch (err) {
    console.error('[admin] Config fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

module.exports = { router, checkAdmin };
