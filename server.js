const cors = require('cors');
// ─────────────────────────────────────────────────────────────────────────────
// Cordfol.io — Express Server Entry Point (server.js)
//
// Wires together:
//   - Express app with session middleware
//   - Auth routes (/api/auth/discord)
//   - Verify routes (/api/verify)
//   - Static file serving for dashboard and index
//   - Public profile route (/api/profile/:slug)
//
// Start with: node server.js
// Or in production: pm2 start server.js --name cordfol
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const connectPg    = require('connect-pg-simple');
const { Pool }     = require('pg');
const path         = require('path');


const { router: authRouter }   = require('./discord');
const { router: verifyRouter } = require('./scan');
const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS for cross-domain session sharing ───────────────────────────────────
const FRONTEND_ORIGIN = 'https://cordfold.vercel.app';
app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true,
}));

// ── Database pool (shared) ────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Session store (PostgreSQL) ────────────────────────────────────────────────
// Stores sessions in the DB so they survive Render restarts.
const PgSession = connectPg(session);

app.use(session({
  store: new PgSession({
    pool: db,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   true,
    sameSite: 'none',
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    domain:   '.cordfol-backend.onrender.com', // exact backend domain for cross-origin session
  },
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files ──────────────────────────────────────────────────────────────
// Serve index.html and dashboard.html from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth/discord', authRouter);
app.use('/api/verify',       verifyRouter);

// ── Public Profile API ────────────────────────────────────────────────────────
// GET /api/profile/:slug — returns JSON for public profile rendering
app.get('/api/profile/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    // Get user
    const userResult = await db.query(`
      SELECT
        u.discord_id, u.discord_username, u.display_name, u.bio,
        u.avatar_hash, u.avatar_url, u.banner_url, u.social_links, u.plan,
        t.background_color, t.accent_color, t.text_color, t.card_color,
        t.glass_enabled, t.glass_blur, t.glass_opacity, t.animated_bg,
        t.music_url, t.music_autoplay, t.custom_css
      FROM users u
      LEFT JOIN themes t ON t.id = u.theme_id
      WHERE u.slug = $1
    `, [slug]);

    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const user = userResult.rows[0];

    // Get verified roles (public only, active only)
    const rolesResult = await db.query(`
      SELECT
        guild_id, guild_name, guild_icon_hash,
        role_id, role_name, role_color,
        proof_type, verified_at, custom_label, display_order
      FROM verified_roles
      WHERE user_id = (SELECT id FROM users WHERE slug = $1)
        AND is_public = true
        AND is_active = true
      ORDER BY display_order ASC, verified_at DESC
    `, [slug]);

    // Log analytics event (fire and forget)
    const visitorId = req.session?.userId || null;
    if (!visitorId || visitorId !== user.discord_id) {
      db.query(`
        INSERT INTO analytics_events (id, user_id, type, metadata, created_at)
        SELECT gen_random_uuid(), u.id, 'profile_view',
          $1::jsonb, NOW()
        FROM users u WHERE u.slug = $2
      `, [
        JSON.stringify({ referrer: req.get('Referer') || null }),
        slug
      ]).catch(() => {}); // silent fail
    }

    res.json({
      profile: {
        slug,
        discordId:   user.discord_id,
        displayName: user.display_name || user.discord_username,
        bio:         user.bio,
        avatarUrl:   user.avatar_url ||
          (user.avatar_hash
            ? `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar_hash}.png`
            : null),
        bannerUrl:   user.banner_url,
        socialLinks: user.social_links,
        plan:        user.plan,
      },
      theme: {
        backgroundColor: user.background_color || '#0d0d0d',
        accentColor:     user.accent_color     || '#5865F2',
        textColor:       user.text_color       || '#ffffff',
        cardColor:       user.card_color       || '#111111',
        glassEnabled:    user.glass_enabled    || false,
        glassBlur:       user.glass_blur       || 12,
        glassOpacity:    user.glass_opacity    || 0.15,
        animatedBg:      user.animated_bg      || false,
        musicUrl:        user.music_url        || null,
        musicAutoplay:   user.music_autoplay   || false,
        customCss:       user.custom_css       || null,
      },
      roles: rolesResult.rows.map(r => ({
        guildId:       r.guild_id,
        guildName:     r.guild_name,
        guildIconHash: r.guild_icon_hash,
        roleId:        r.role_id,
        roleName:      r.custom_label || r.role_name,
        roleColor:     r.role_color
          ? `#${r.role_color.toString(16).padStart(6, '0')}`
          : null,
        proofType:     r.proof_type,
        verifiedAt:    r.verified_at,
      })),
    });

  } catch (err) {
    console.error('[server] /api/profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/profile — update user profile (auth required)
app.post('/api/profile', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { display_name, slug, bio, social_links } = req.body;
    if (!slug || !display_name) return res.status(400).json({ error: 'Missing required fields' });

    // Check for slug conflict
    const conflict = await db.query('SELECT id FROM users WHERE slug = $1 AND id != $2', [slug, userId]);
    if (conflict.rowCount > 0) return res.status(409).json({ error: 'Slug already taken' });

    await db.query(`
      UPDATE users SET
        display_name = $1,
        slug = $2,
        bio = $3,
        social_links = $4,
        updated_at = NOW()
      WHERE id = $5
    `, [display_name, slug, bio, social_links, userId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[server] /api/profile POST error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Dashboard route (auth-gated) ──────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Public profile page ───────────────────────────────────────────────────────
// Any other route that doesn't match API or static files = public profile
app.get('/:slug', (req, res) => {
  const reserved = ['api', 'dashboard', 'login', 'logout', 'static'];
  if (reserved.includes(req.params.slug)) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Cordfol.io running on port ${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
