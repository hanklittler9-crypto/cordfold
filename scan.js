// ─────────────────────────────────────────────────────────────────────────────
// Cordfol.io — Verification Engine (api/verify/scan.js)
//
// Two responsibilities:
//   1. POST /api/verify/scan       → Manual re-scan triggered from dashboard
//   2. runBackgroundReverify()     → Cron job that re-checks all users every 24h
//
// Rate limit strategy:
//   - OAuth user tokens: max ~40 req/10s. We stagger at 250ms between guilds.
//   - Bot token (in bot/index.js): 1000 req/10s, used for /verify command.
//   - Background re-verify: staggered across 24h window, never bursts.
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const { Pool } = require('pg');
const { getValidAccessToken } = require('./discord');
const { maybeSendRoleChangeAlert } = require('./email');

const router = express.Router();

const DISCORD_API = 'https://discord.com/api/v10';

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/verify/scan
// Manual re-scan. Called from dashboard "Re-scan Guilds" button.
// Returns immediately with a job ID; scan runs async.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/scan', requireAuth, async (req, res) => {
  const userId = req.session.userId;

  // Debounce: don't allow re-scan more than once per 2 minutes
  const lastScan = await db.query(
    'SELECT updated_at FROM users WHERE id = $1',
    [userId]
  );

  const updatedAt = new Date(lastScan.rows[0]?.updated_at || 0);
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

  if (updatedAt > twoMinutesAgo) {
    return res.status(429).json({
      error: 'Re-scan too soon',
      retryAfter: Math.ceil((updatedAt - twoMinutesAgo) / 1000),
    });
  }

  // Respond immediately — don't make the user wait for the scan
  res.json({ ok: true, message: 'Scan started' });

  // Run scan in background
  runScanForUser(userId).catch(err =>
    console.error(`[scan] Background scan failed for ${userId}:`, err)
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: GET /api/verify/roles
// Returns the user's current verified roles for the dashboard.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/roles', requireAuth, async (req, res) => {
  const userId = req.session.userId;

  try {
    const result = await db.query(`
      SELECT
        id, guild_id, guild_name, guild_icon_hash,
        role_id, role_name, role_color,
        proof_type, is_active, is_public,
        verified_at, last_checked_at, custom_label, display_order
      FROM verified_roles
      WHERE user_id = $1
      ORDER BY is_active DESC, display_order ASC, verified_at DESC
    `, [userId]);

    res.json({ roles: result.rows });
  } catch (err) {
    console.error('[scan] /roles error:', err);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: PATCH /api/verify/roles/:id
// Update role visibility, display order, or custom label.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/roles/:id', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const roleId = req.params.id;
  const { isPublic, displayOrder, customLabel } = req.body;

  try {
    // Verify ownership before updating
    const check = await db.query(
      'SELECT id FROM verified_roles WHERE id = $1 AND user_id = $2',
      [roleId, userId]
    );
    if (check.rowCount === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }

    await db.query(`
      UPDATE verified_roles
      SET
        is_public     = COALESCE($1, is_public),
        display_order = COALESCE($2, display_order),
        custom_label  = COALESCE($3, custom_label)
      WHERE id = $4 AND user_id = $5
    `, [isPublic, displayOrder, customLabel, roleId, userId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[scan] PATCH /roles error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Core scan function — fetches all guilds and re-verifies roles for one user.
// Called by:
//   - Manual /api/verify/scan endpoint
//   - runBackgroundReverify() cron
//   - triggerGuildScan() in auth/discord.js (on login)
// ─────────────────────────────────────────────────────────────────────────────
async function runScanForUser(userId) {
  console.log(`[scan] Starting scan for user ${userId}`);

  // Snapshot active roles so we can email the user about anything that drops
  let rolesBefore = [];
  try {
    const snap = await db.query(`
      SELECT guild_id, role_id, role_name, custom_label, guild_name
      FROM verified_roles
      WHERE user_id = $1 AND is_active = true
    `, [userId]);
    rolesBefore = snap.rows;
  } catch { /* non-critical */ }

  let accessToken;
  try {
    accessToken = await getValidAccessToken(userId);
  } catch (err) {
    console.warn(`[scan] Cannot get valid token for ${userId}: ${err.message}`);
    // If refresh failed, user needs to re-authenticate
    await db.query(
      'UPDATE users SET updated_at = NOW() WHERE id = $1',
      [userId]
    );
    return { error: 'token_invalid', userId };
  }

  // ── Fetch guild list ────────────────────────────────────────────────────────
  const guildsRes = await fetch(`https://discord.com/api/v10/users/@me/guilds?limit=200`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!guildsRes.ok) {
    console.warn(`[scan] Guild list fetch failed for ${userId}: ${guildsRes.status}`);
    return { error: 'guilds_fetch_failed' };
  }

  const guilds = await guildsRes.json();
  const guildIds = guilds.map(g => g.id);

  // ── Mark all existing roles as "pending re-check" ───────────────────────────
  // We'll update last_checked_at as we process each. Roles not seen after the
  // scan will be flipped to is_active = false by the cleanup step.
  const seenRoleKeys = new Set(); // tracks "userId:guildId:roleId" we confirmed

  // ── Per-guild member fetch ──────────────────────────────────────────────────
  for (const guild of guilds) {
    // Rate limit: 250ms gap between requests = ~4 req/s, very safe
    await sleep(250);

    try {
      const memberRes = await fetch(
        `${DISCORD_API}/users/@me/guilds/${guild.id}/member`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      // 403 = bot required / not in server / missing permissions — skip
      // 404 = user not in server anymore
      if (memberRes.status === 403 || memberRes.status === 404) {
        // Mark all roles in this guild as inactive
        await db.query(`
          UPDATE verified_roles SET is_active = false, last_checked_at = NOW()
          WHERE user_id = $1 AND guild_id = $2 AND proof_type = 'OAUTH'
        `, [userId, guild.id]);
        continue;
      }

      if (!memberRes.ok) continue;

      const member = await memberRes.json();
      const roleIds = member.roles || [];

      // Resolve role names via bot token (only works in guilds the bot is in)
      const roleInfo = await fetchGuildRoleMap(guild.id);

      // For each confirmed role, upsert
      for (const roleId of roleIds) {
        seenRoleKeys.add(`${guild.id}:${roleId}`);

        const info = roleInfo.get(roleId);
        const roleName = info?.name || null;
        const roleColor = info?.color || null;

        await db.query(`
          INSERT INTO verified_roles
            (id, user_id, guild_id, guild_name, guild_icon_hash, role_id, role_name, role_color,
             verified_at, last_checked_at, is_active, proof_type, is_public, display_order)
          VALUES
            (gen_random_uuid(), $1, $2, $3, $4, $5, COALESCE($6, $5), $7,
             NOW(), NOW(), true, 'OAUTH'::\"ProofType\", true, 0)
          ON CONFLICT (user_id, guild_id, role_id)
          DO UPDATE SET
            is_active       = true,
            last_checked_at = NOW(),
            guild_name      = EXCLUDED.guild_name,
            guild_icon_hash = EXCLUDED.guild_icon_hash,
            role_name       = CASE
              WHEN $6::text IS NOT NULL THEN $6
              ELSE verified_roles.role_name
            END,
            role_color      = COALESCE($7, verified_roles.role_color),
            proof_type      = CASE
              WHEN verified_roles.proof_type = 'BOT' THEN 'BOT'
              ELSE 'OAUTH' 
            END
        `, [userId, guild.id, guild.name, guild.icon, roleId, roleName, roleColor]);
      }

      // Deactivate roles the user no longer has in this guild (OAuth-only)
      if (roleIds.length > 0) {
        await db.query(`
          UPDATE verified_roles
          SET is_active = false, last_checked_at = NOW()
          WHERE user_id = $1
            AND guild_id = $2
            AND proof_type = 'OAUTH'
            AND role_id != ALL($3::text[])
        `, [userId, guild.id, roleIds]);
      }

    } catch (err) {
      console.warn(`[scan] Error on guild ${guild.id} for user ${userId}:`, err.message);
    }
  }

  // ── Deactivate roles in guilds no longer in the user's guild list ───────────
  if (guildIds.length > 0) {
    await db.query(`
      UPDATE verified_roles
      SET is_active = false, last_checked_at = NOW()
      WHERE user_id = $1
        AND guild_id != ALL($2::text[])
        AND proof_type = 'OAUTH'
    `, [userId, guildIds]);
  }

  // ── Update last scan timestamp ──────────────────────────────────────────────
  await db.query(
    'UPDATE users SET updated_at = NOW() WHERE id = $1',
    [userId]
  );

  // ── Email alert for roles that went inactive this scan ──────────────────────
  if (rolesBefore.length) {
    try {
      const after = await db.query(`
        SELECT guild_id, role_id FROM verified_roles
        WHERE user_id = $1 AND is_active = true
      `, [userId]);
      const stillActive = new Set(after.rows.map(r => `${r.guild_id}:${r.role_id}`));
      const lostRoles = rolesBefore
        .filter(r => !stillActive.has(`${r.guild_id}:${r.role_id}`))
        .map(r => ({
          roleName: r.custom_label || r.role_name,
          roleId: r.role_id,
          guildName: r.guild_name,
        }));

      if (lostRoles.length) {
        maybeSendRoleChangeAlert(db, userId, lostRoles).catch(err =>
          console.error('[scan] Role alert failed:', err.message)
        );
      }
    } catch { /* non-critical */ }
  }

  console.log(`[scan] Scan complete for user ${userId}. ${guilds.length} guilds processed.`);
  return { ok: true, guildsScanned: guilds.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Background Re-verifier (cron job)
//
// Run this on a schedule — e.g. every hour via node-cron or a Render cron job.
// It processes all users in batches, staggered to avoid rate limit bursts.
//
// On Render free tier: set this up as a separate Cron Job service pointing
// at a /api/verify/cron endpoint protected by a CRON_SECRET env var.
// ─────────────────────────────────────────────────────────────────────────────
async function runBackgroundReverify() {
  console.log('[cron] Starting background re-verification run...');

  // Get all users whose last scan was > 23 hours ago
  const users = await db.query(`
    SELECT id FROM users
    WHERE updated_at < NOW() - INTERVAL '23 hours'
    ORDER BY updated_at ASC
    LIMIT 500
  `);

  console.log(`[cron] ${users.rowCount} users need re-verification`);

  for (const user of users.rows) {
    // Stagger: 3 seconds between users to spread load across the hour
    // 500 users × 3s = 1500s = 25 minutes. Safe for Render.
    await sleep(3000);

    try {
      await runScanForUser(user.id);
    } catch (err) {
      console.error(`[cron] Re-verify failed for ${user.id}:`, err.message);
    }
  }

  console.log('[cron] Background re-verification complete.');
}

// ── Cron endpoint (protected) ─────────────────────────────────────────────────
router.post('/cron', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Don't await — respond immediately and run in background
  res.json({ ok: true, message: 'Re-verification started' });
  runBackgroundReverify().catch(err =>
    console.error('[cron] runBackgroundReverify error:', err)
  );
});

// ── Role name lookup (bot token) ──────────────────────────────────────────────
// OAuth member endpoint only returns role IDs. Use the bot token to resolve
// names/colors — works for guilds the bot is in; others keep the ID as a
// fallback until the bot is added. Cached 10 min per guild.
const roleMapCache = new Map(); // guildId -> { expires, map }

async function fetchGuildRoleMap(guildId) {
  const cached = roleMapCache.get(guildId);
  if (cached && cached.expires > Date.now()) return cached.map;

  const map = new Map();
  const botToken = process.env.BOT_TOKEN;
  if (botToken) {
    try {
      const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
        headers: { Authorization: `Bot ${botToken}` },
      });
      if (res.ok) {
        const roles = await res.json();
        for (const r of roles) {
          map.set(r.id, {
            name: r.name,
            color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null,
          });
        }
      }
    } catch (err) {
      console.warn(`[scan] Role lookup failed for guild ${guildId}:`, err.message);
    }
  }

  roleMapCache.set(guildId, { expires: Date.now() + 10 * 60 * 1000, map });
  return map;
}

// ── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { router, runScanForUser, runBackgroundReverify };
