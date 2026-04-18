// ─────────────────────────────────────────────────────────────────────────────
// Cordfol.io — Express Server Entry Point
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const connectPg    = require('connect-pg-simple');
const { Pool }     = require('pg');
const path         = require('path');
const cors         = require('cors');
const cookieParser = require('cookie-parser');

// ✅ FIXED: match your exports (module.exports = router)
const authRouter   = require('./discord');
const { router: verifyRouter } = require('./scan');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────────────────────
const FRONTEND_ORIGIN = [
  'https://dashboard.cordfol.org',
  'https://cordfold.vercel.app'
];

app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true,
}));

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Session Store ────────────────────────────────────────────────────────────
const PgSession = connectPg(session);

app.use(session({
  store: new PgSession({
    pool: db,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,          // ⚠️ must be HTTPS in production
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    domain: '.cordfol.org',
  },
}));

// ── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth/discord', authRouter);
app.get('/api/auth/me', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ authenticated: false });
  }
  try {
    const row = await db.query(
      'SELECT discord_id, discord_username, avatar_hash, slug, display_name, bio, plan FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (row.rowCount === 0) {
      req.session.destroy(() => {});
      return res.status(401).json({ authenticated: false });
    }
    const u = row.rows[0];
    res.json({
      authenticated: true,
      user: {
        discordId:   u.discord_id,
        username:    u.discord_username,
        avatarUrl:   u.avatar_hash
          ? `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar_hash}.png`
          : null,
        slug:        u.slug,
        displayName: u.display_name,
        bio:         u.bio,
        plan:        u.plan,
      }
    });
  } catch (err) {
    console.error('[server] /api/auth/me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
app.use('/api/verify', verifyRouter);

// ── Public Profile API ───────────────────────────────────────────────────────
app.get('/api/profile/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const userResult = await db.query(`
      SELECT
        u.id, u.discord_id, u.discord_username, u.display_name, u.bio,
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

    // analytics (non-blocking)
    const visitorId = req.session?.userId || null;
    if (!visitorId || visitorId !== user.id) {
      db.query(`
        INSERT INTO analytics_events (id, user_id, type, metadata, created_at)
        SELECT gen_random_uuid(), u.id, 'profile_view',
          $1::jsonb, NOW()
        FROM users u WHERE u.slug = $2
      `, [
        JSON.stringify({ referrer: req.get('Referer') || null }),
        slug
      ]).catch(() => {});
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
        guildId: r.guild_id,
        guildName: r.guild_name,
        guildIconHash: r.guild_icon_hash,
        roleId: r.role_id,
        roleName: r.custom_label || r.role_name,
        roleColor: r.role_color
          ? `#${r.role_color.toString(16).padStart(6, '0')}`
          : null,
        proofType: r.proof_type,
        verifiedAt: r.verified_at,
      })),
    });

  } catch (err) {
    console.error('[server] /api/profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Update Profile ───────────────────────────────────────────────────────────
app.post('/api/profile', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { display_name, slug, bio, social_links } = req.body;
    if (!slug || !display_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const conflict = await db.query(
      'SELECT id FROM users WHERE slug = $1 AND id != $2',
      [slug, userId]
    );

    if (conflict.rowCount > 0) {
      return res.status(409).json({ error: 'Slug already taken' });
    }

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

// ── Dashboard Route ──────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Public Profile Page ──────────────────────────────────────────────────────
app.get('/:slug', (req, res) => {
  const reserved = ['api', 'dashboard', 'login', 'logout', 'static'];
  if (reserved.includes(req.params.slug)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// ── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
});

module.exports = app;