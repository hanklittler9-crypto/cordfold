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

const authRouter             = require('./discord');
const { router: verifyRouter } = require('./scan');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────────────────────
const FRONTEND_ORIGIN = [
  'https://dashboard.cordfol.org',
  'https://cordfol.org',
  'https://www.cordfol.org',
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
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    domain: '.cordfol.org',
  },
}));

// ── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Debug Route ───────────────────────────────────────────────────────────────
app.get('/api/auth/debug', async (req, res) => {
  try {
    const result = await db.query('SELECT sid, sess FROM user_sessions ORDER BY expire DESC LIMIT 5');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Token Auth ────────────────────────────────────────────────────────────────
app.get('/api/auth/token', async (req, res) => {
  const { sid } = req.query;
  if (!sid) return res.status(400).json({ error: 'No sid' });

  try {
    const result = await db.query(
      'SELECT sess FROM user_sessions WHERE sid = $1',
      [sid]
    );
    if (result.rowCount === 0) return res.status(401).json({ authenticated: false });

    const sess = result.rows[0].sess;
    if (!sess.userId) return res.status(401).json({ authenticated: false });

    const userResult = await db.query(
      'SELECT discord_id, discord_username, avatar_hash, slug, display_name, bio, plan FROM users WHERE id = $1',
      [sess.userId]
    );
    if (userResult.rowCount === 0) return res.status(401).json({ authenticated: false });

    const u = userResult.rows[0];
    res.json({
      authenticated: true,
      user: {
        discordId:   u.discord_id,
        username:    u.discord_username,
        avatarUrl:   u.avatar_hash ? `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar_hash}.png` : null,
        slug:        u.slug,
        displayName: u.display_name,
        bio:         u.bio,
        plan:        u.plan,
      }
    });
  } catch (err) {
    console.error('[token] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── API Routes ────────────────────────────────────────────────────────────────
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

app.use('/api/verify', async (req, res, next) => {
  const { sid } = req.query;
  if (sid && !req.session?.userId) {
    try {
      const result = await db.query('SELECT sess FROM user_sessions WHERE sid = $1', [sid]);
      if (result.rowCount > 0 && result.rows[0].sess?.userId) {
        req.session.userId = result.rows[0].sess.userId;
      }
    } catch (err) {
      console.error('[verify] Session lookup error:', err);
    }
  }
  next();
});
app.use('/api/verify', verifyRouter);

// ── Public Profile API ────────────────────────────────────────────────────────
app.use('/api/profile', async (req, res, next) => {
  const { sid } = req.query;
  if (sid && !req.session?.userId) {
    try {
      const result = await db.query('SELECT sess FROM user_sessions WHERE sid = $1', [sid]);
      if (result.rowCount > 0 && result.rows[0].sess?.userId) {
        req.session.userId = result.rows[0].sess.userId;
      }
    } catch (err) {
      console.error('[profile] Session lookup error:', err);
    }
  }
  next();
});
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
        guildId:       r.guild_id,
        guildName:     r.guild_name,
        guildIconHash: r.guild_icon_hash,
        roleId:        r.role_id,
        roleName:      r.custom_label || r.role_name,
        roleColor:     r.role_color
          ? `#${r.role_color.toString(16).padStart(6, '0')}`
          : null,
        proofType:  r.proof_type,
        verifiedAt: r.verified_at,
      })),
    });

  } catch (err) {
    console.error('[server] /api/profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Update Profile ────────────────────────────────────────────────────────────
app.post('/api/profile', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const {
      display_name,
      slug,
      bio,
      bannerUrl,
      social_links,
      theme = {}
    } = req.body;

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
        banner_url = $4,
        social_links = $5,
        updated_at = NOW()
      WHERE id = $6
    `, [display_name, slug, bio, bannerUrl, social_links, userId]);

    const themeRow = await db.query(`
      SELECT t.id, t.is_preset
      FROM themes t
      JOIN users u ON u.theme_id = t.id
      WHERE u.id = $1
    `, [userId]);

    const themeFields = [
      theme.backgroundColor || '#0d0d0d',
      theme.accentColor || '#5865F2',
      theme.textColor || '#ffffff',
      theme.cardColor || '#111111',
      theme.glassEnabled ? true : false,
      Number(theme.glassBlur || 12),
      Number(theme.glassOpacity || 0.15),
      theme.animatedBg ? true : false,
      theme.musicUrl || null,
      theme.musicAutoplay ? true : false,
      theme.customCss || null,
    ];

    if (themeRow.rowCount > 0 && !themeRow.rows[0].is_preset) {
      await db.query(`
        UPDATE themes SET
          background_color = $1,
          accent_color     = $2,
          text_color       = $3,
          card_color       = $4,
          glass_enabled    = $5,
          glass_blur       = $6,
          glass_opacity    = $7,
          animated_bg      = $8,
          music_url        = $9,
          music_autoplay   = $10,
          custom_css       = $11
        WHERE id = $12
      `, [...themeFields, themeRow.rows[0].id]);
    } else {
      const insertTheme = await db.query(`
        INSERT INTO themes (
          name, is_default, is_preset,
          background_color, accent_color, text_color, card_color,
          glass_enabled, glass_blur, glass_opacity, animated_bg,
          music_url, music_autoplay, custom_css
        ) VALUES (
          $1, false, false,
          $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12
        ) RETURNING id
      `, [
        `Custom theme for user ${userId}`,
        ...themeFields
      ]);

      await db.query('UPDATE users SET theme_id = $1 WHERE id = $2', [insertTheme.rows[0].id, userId]);
    }

    res.json({ ok: true });

  } catch (err) {
    console.error('[server] /api/profile POST error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Dashboard Route ───────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Public Profile Page ───────────────────────────────────────────────────────
app.get('/:slug', (req, res) => {
  const reserved = ['api', 'dashboard', 'login', 'logout', 'static'];
  if (reserved.includes(req.params.slug)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
});

// ── Start Bot ─────────────────────────────────────────────────────────────────
require('./bot/index.js');

module.exports = app;