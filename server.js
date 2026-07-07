// ─────────────────────────────────────────────────────────────────────────────
// Cordfol.io — Express Server Entry Point
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const connectPg    = require('connect-pg-simple');
const { Pool }     = require('pg');
const path         = require('path');
const fs           = require('fs');
const cors         = require('cors');
const cookieParser = require('cookie-parser');

const authRouter              = require('./discord');
const { router: verifyRouter } = require('./scan');
const { router: adminRouter }  = require('./admin');
const { runMigrations }        = require('./migrations');
const {
  sendVerificationEmail,
  isConfigured: emailConfigured,
  maybeSendSetupReminder,
} = require('./email');
const createSpotifyRouter = require('./spotify');

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const { authRouter: spotifyAuthRouter, apiRouter: spotifyApiRouter, getNowPlayingForUser } = createSpotifyRouter(db);

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

// ── Spotify (session via sid query, same as profile) ─────────────────────────
app.use('/api/auth/spotify', async (req, res, next) => {
  const { sid } = req.query;
  if (sid && !req.session?.userId) {
    try {
      const result = await db.query('SELECT sess FROM user_sessions WHERE sid = $1', [sid]);
      if (result.rowCount > 0 && result.rows[0].sess?.userId) {
        req.session.userId = result.rows[0].sess.userId;
        return req.session.save((err) => {
          if (err) console.error('[spotify] Session save error:', err);
          next();
        });
      }
    } catch (err) {
      console.error('[spotify] Session lookup error:', err);
    }
  }
  next();
});
app.use('/api/auth/spotify', spotifyAuthRouter);

app.get('/api/spotify/now-playing/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const userRow = await db.query(
      'SELECT id FROM users WHERE slug = $1',
      [slug]
    );
    if (userRow.rowCount === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const nowPlaying = await getNowPlayingForUser(userRow.rows[0].id);
    if (!nowPlaying) {
      return res.status(404).json({ error: 'Spotify not connected or not public' });
    }

    res.json(nowPlaying);
  } catch (err) {
    console.error('[server] /api/spotify/now-playing error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.use('/api/spotify', spotifyApiRouter);

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
        u.avatar_hash, u.avatar_url, u.banner_url, u.social_links, u.custom_links, u.plan,
        u.created_at, u.timezone,
        u.email, u.email_verified, u.email_role_alerts,
        u.spotify_enabled, u.spotify_public,
        t.background_color, t.accent_color, t.text_color, t.card_color,
        t.glass_enabled, t.glass_blur, t.glass_opacity, t.animated_bg,
        t.music_url, t.music_autoplay, t.custom_css,
        t.bg_type, t.bg_value, t.layout, t.font_family,
        t.card_opacity, t.particles_enabled, t.bg_blur_enabled,
        t.entry_splash, t.typewriter_bio, t.tilt_card, t.name_effect,
        u.presence_status, u.presence_activity, u.presence_updated_at,
        u.display_options
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

    let viewCount = 0;
    try {
      const vc = await db.query(
        `SELECT COUNT(*) AS c FROM analytics_events WHERE user_id = $1 AND type = 'profile_view'`,
        [user.id]
      );
      viewCount = Number(vc.rows[0]?.c || 0);
    } catch { /* non-critical */ }

    const rawMusic = user.music_url || null;
    const musicIsEmbedded = rawMusic && String(rawMusic).startsWith('data:');

    // Profile badges — computed, never self-assigned
    const badges = [];
    if (user.discord_id === '1127435524022472805') {
      badges.push({ id: 'creator', label: 'Cordfol Creator' });
    }
    if (String(user.plan).toUpperCase() === 'PRO') {
      badges.push({ id: 'pro', label: 'Pro Member' });
    }
    if (user.created_at && new Date(user.created_at) < new Date('2026-10-01')) {
      badges.push({ id: 'early', label: 'Early Adopter' });
    }
    if (viewCount >= 10000) badges.push({ id: 'views10k', label: '10K Views Club' });
    else if (viewCount >= 1000) badges.push({ id: 'views1k', label: '1K Views Club' });
    if (rolesResult.rows.some(r => r.proof_type === 'BOT')) {
      badges.push({ id: 'bot', label: 'Bot Verified' });
    }
    if (user.spotify_enabled && user.spotify_public) {
      badges.push({ id: 'music', label: 'Music Connected' });
    }

    res.set('Cache-Control', 'private, no-store, must-revalidate');
    res.json({
      profile: {
        slug,
        discordId:   user.discord_id,
        memberSince: discordMemberSince(user.discord_id),
        displayName: user.display_name || user.discord_username,
        bio:         user.bio,
        avatarUrl:   user.avatar_url ||
          (user.avatar_hash
            ? `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar_hash}.${String(user.avatar_hash).startsWith('a_') ? 'gif' : 'png'}?size=256`
            : null),
        timezone:    user.timezone || null,
        bannerUrl:   user.banner_url,
        socialLinks: user.social_links,
        customLinks: user.custom_links || [],
        email:       user.email,
        emailVerified: user.email_verified || false,
        emailRoleAlerts: user.email_role_alerts !== false,
        plan:        user.plan,
        spotify: {
          public: !!(user.spotify_enabled && user.spotify_public),
        },
        viewCount,
        badges,
        displayOptions: normalizeDisplayOptions(user.display_options),
      },
      theme: {
        backgroundColor: user.background_color || '#0d0d0d',
        accentColor:     user.accent_color     || '#5865F2',
        textColor:       user.text_color       || '#ffffff',
        cardColor:       user.card_color       || '#111111',
        cardOpacity:     user.card_opacity     != null ? user.card_opacity : 0.92,
        glassEnabled:    user.glass_enabled    || false,
        glassmorphism:   user.glass_enabled    || false,
        glassBlur:       user.glass_blur       || 12,
        glassOpacity:    user.glass_opacity    || 0.15,
        animatedBg:      user.animated_bg      || false,
        musicUrl:        musicIsEmbedded ? null : (rawMusic || null),
        musicLegacy:     musicIsEmbedded || false,
        musicAutoplay:   user.music_autoplay   || false,
        customCss:       user.custom_css       || null,
        bgType:          user.bg_type          || 'solid',
        bgValue:         user.bg_value         || null,
        layout:          user.layout           || 'centered',
        font:            user.font_family      || 'DM Sans',
        particles:       user.particles_enabled || false,
        bgBlur:          user.bg_blur_enabled  || false,
        entrySplash:     user.entry_splash     || false,
        typewriterBio:   user.typewriter_bio   || false,
        tiltCard:        user.tilt_card        || false,
        nameEffect:      user.name_effect      || 'none',
      },
      presence: user.presence_status ? {
        status:   user.presence_status,
        activity: user.presence_activity || null,
        // Presence older than 12h is likely stale (bot restart, user left shared guild)
        stale: user.presence_updated_at
          ? (Date.now() - new Date(user.presence_updated_at).getTime()) > 12 * 60 * 60 * 1000
          : true,
      } : null,
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
        isPinned:      r.display_order != null && r.display_order < 3,
        displayOrder:  r.display_order,
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
      custom_links,
      email,
      email_role_alerts,
      display_options,
      timezone,
      theme = {}
    } = req.body;

    if (!slug || !display_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Sanitize custom links: max 10, each needs a title + http(s) URL
    const cleanLinks = (Array.isArray(custom_links) ? custom_links : [])
      .slice(0, 10)
      .map(l => ({
        title: String(l?.title || '').trim().slice(0, 60),
        url: String(l?.url || '').trim().slice(0, 500),
      }))
      .filter(l => l.title && /^https?:\/\//i.test(l.url));

    const conflict = await db.query(
      'SELECT id FROM users WHERE slug = $1 AND id != $2',
      [slug, userId]
    );

    if (conflict.rowCount > 0) {
      return res.status(409).json({ error: 'Slug already taken' });
    }

    const cleanDisplay = normalizeDisplayOptions(display_options);

    await db.query(`
      UPDATE users SET
        display_name = $1,
        slug = $2,
        bio = $3,
        banner_url = $4,
        social_links = $5,
        custom_links = $6,
        email = NULLIF(TRIM($7), ''),
        display_options = $8,
        email_role_alerts = $9,
        timezone = COALESCE(NULLIF(TRIM($10), ''), timezone),
        updated_at = NOW()
      WHERE id = $11
    `, [display_name, slug, bio, bannerUrl, social_links, JSON.stringify(cleanLinks), email || '', JSON.stringify(cleanDisplay), email_role_alerts !== false, String(timezone || '').slice(0, 64), userId]);

    const themeRow = await db.query(`
      SELECT t.id, t.is_preset
      FROM themes t
      JOIN users u ON u.theme_id = t.id
      WHERE u.id = $1
    `, [userId]);

    const bgType = theme.bgType || 'solid';
    const bgValue = theme.bgValue || null;
    let backgroundColor = theme.backgroundColor || '#0d0d0d';
    if (bgType === 'solid' && bgValue) backgroundColor = bgValue;
    else if (bgType === 'gradient' && bgValue) backgroundColor = bgValue;
    else if (bgType === 'gif' || bgType === 'video') backgroundColor = '#09090d';

    let musicUrl = theme.musicUrl || null;
    if (musicUrl && String(musicUrl).startsWith('data:')) {
      return res.status(400).json({
        error: 'Use the MP3 upload picker or paste a direct file URL — embedded data URLs are not allowed.',
      });
    }
    if (musicUrl && isBlockedMusicUrl(musicUrl)) {
      return res.status(400).json({
        error: 'YouTube and Spotify page links cannot play as background music. Upload an MP3 or use the Spotify tab for now playing.',
      });
    }
    if (musicUrl && String(musicUrl).length > 2000) {
      return res.status(400).json({ error: 'Music URL too long' });
    }

    const allowedFonts = new Set([
      'DM Sans', 'Space Mono', 'Bebas Neue',
      'Instrument Serif', 'Syne', 'IBM Plex Mono',
    ]);
    const fontFamily = allowedFonts.has(theme.font) ? theme.font : 'DM Sans';
    const layout = ['centered', 'left', 'card', 'magazine'].includes(theme.layout)
      ? theme.layout
      : 'centered';
    const nameEffect = ['none', 'glow', 'gradient', 'rainbow', 'sparkle'].includes(theme.nameEffect)
      ? theme.nameEffect
      : 'none';

    const themeFields = [
      backgroundColor,
      theme.accentColor || '#5865F2',
      theme.textColor || '#ffffff',
      theme.cardColor || '#111111',
      theme.glassmorphism || theme.glassEnabled ? true : false,
      Number(theme.glassBlur || 12),
      Number(theme.glassOpacity || 0.15),
      theme.animatedBg ? true : false,
      musicUrl,
      theme.musicAutoplay ? true : false,
      theme.customCss || null,
      bgType,
      bgValue,
      layout,
      fontFamily,
      theme.cardOpacity != null ? Number(theme.cardOpacity) / (Number(theme.cardOpacity) > 1 ? 100 : 1) : 0.92,
      theme.particles ? true : false,
      theme.bgBlur ? true : false,
      theme.entrySplash ? true : false,
      theme.typewriterBio ? true : false,
      theme.tiltCard ? true : false,
      nameEffect,
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
          custom_css       = $11,
          bg_type          = $12,
          bg_value         = $13,
          layout           = $14,
          font_family      = $15,
          card_opacity     = $16,
          particles_enabled = $17,
          bg_blur_enabled  = $18,
          entry_splash     = $19,
          typewriter_bio   = $20,
          tilt_card        = $21,
          name_effect      = $22
        WHERE id = $23
      `, [...themeFields, themeRow.rows[0].id]);
    } else {
      const insertTheme = await db.query(`
        INSERT INTO themes (
          id, name, is_default, is_preset, is_pro,
          background_color, accent_color, text_color, card_color,
          glass_enabled, glass_blur, glass_opacity, animated_bg,
          music_url, music_autoplay, custom_css,
          bg_type, bg_value, layout, font_family, card_opacity,
          particles_enabled, bg_blur_enabled,
          entry_splash, typewriter_bio, tilt_card, name_effect
        ) VALUES (
          gen_random_uuid(), $1, false, false, false,
          $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12,
          $13, $14, $15, $16, $17,
          $18, $19,
          $20, $21, $22, $23
        ) RETURNING id
      `, [
        `Custom theme for user ${userId}`,
        ...themeFields
      ]);

      await db.query('UPDATE users SET theme_id = $1 WHERE id = $2', [insertTheme.rows[0].id, userId]);
    }

    // Setup reminder goes to the email they entered in profile — not on signup
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      maybeSendSetupReminder(db, userId).catch(err =>
        console.error('[server] Setup reminder error:', err.message)
      );
    }

    res.json({ ok: true });

  } catch (err) {
    console.error('[server] /api/profile POST error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Music file upload (stored as file, not in DB) ─────────────────────────────
app.post('/api/profile/music-upload', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { data, filename } = req.body || {};
    if (!data) return res.status(400).json({ error: 'No file data' });

    const b64 = String(data).replace(/^data:audio\/[^;]+;base64,/, '');
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      return res.status(400).json({ error: 'Invalid audio data' });
    }

    if (!buf.length) return res.status(400).json({ error: 'Empty file' });
    if (buf.length > MAX_MUSIC_BYTES) {
      return res.status(400).json({ error: 'File too large (max 5MB)' });
    }

    const ext = filename && /\.(mp3|wav|ogg|m4a)$/i.test(filename)
      ? path.extname(filename).toLowerCase()
      : '.mp3';
    const safeName = `${String(userId).replace(/[^a-zA-Z0-9-]/g, '')}${ext}`;
    await fs.promises.writeFile(path.join(MUSIC_UPLOAD_DIR, safeName), buf);

    res.json({ url: `${API_ORIGIN}/uploads/music/${safeName}` });
  } catch (err) {
    console.error('[server] /api/profile/music-upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── Email Verification ────────────────────────────────────────────────────────
app.post('/api/profile/verify-email', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!emailConfigured()) {
      return res.status(503).json({ error: 'Email service not configured' });
    }

    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const userRow = await db.query(
      'SELECT display_name, discord_username FROM users WHERE id = $1',
      [userId]
    );
    if (userRow.rowCount === 0) return res.status(401).json({ error: 'User not found' });

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query(`
      UPDATE users SET
        email = $1,
        email_verify_token = $2,
        email_verify_expires = $3,
        email_verified = false
      WHERE id = $4
    `, [email, token, expires, userId]);

    const u = userRow.rows[0];
    await sendVerificationEmail({
      to: email,
      displayName: u.display_name || u.discord_username,
      token,
    });

    res.json({ ok: true, message: 'Verification email sent' });
  } catch (err) {
    console.error('[server] /api/profile/verify-email error:', err);
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect('https://dashboard.cordfol.org/dashboard.html?email=invalid');
  }

  try {
    const row = await db.query(`
      SELECT id, email_verify_expires FROM users
      WHERE email_verify_token = $1
    `, [token]);

    if (row.rowCount === 0) {
      return res.redirect('https://dashboard.cordfol.org/dashboard.html?email=invalid');
    }

    const user = row.rows[0];
    if (new Date(user.email_verify_expires) < new Date()) {
      return res.redirect('https://dashboard.cordfol.org/dashboard.html?email=expired');
    }

    await db.query(`
      UPDATE users SET
        email_verified = true,
        email_verify_token = NULL,
        email_verify_expires = NULL
      WHERE id = $1
    `, [user.id]);

    res.redirect('https://dashboard.cordfol.org/dashboard.html?email=verified');
  } catch (err) {
    console.error('[server] /api/auth/verify-email error:', err);
    res.redirect('https://dashboard.cordfol.org/dashboard.html?email=error');
  }
});

// ── Analytics ─────────────────────────────────────────────────────────────────
async function resolveUserId(req) {
  if (req.session?.userId) return req.session.userId;
  const { sid } = req.query;
  if (!sid) return null;
  try {
    const result = await db.query('SELECT sess FROM user_sessions WHERE sid = $1', [sid]);
    if (result.rowCount > 0 && result.rows[0].sess?.userId) {
      return result.rows[0].sess.userId;
    }
  } catch (err) {
    console.error('[analytics] sid lookup error:', err);
  }
  return null;
}

function discordMemberSince(discordId) {
  if (!discordId) return null;
  try {
    const ts = Number(BigInt(discordId) >> 22n) + 1420070400000;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return null;
  }
}

const MUSIC_UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'music');
const API_ORIGIN = process.env.API_ORIGIN || 'https://api.cordfol.org';
const MAX_MUSIC_BYTES = 5 * 1024 * 1024;

try {
  fs.mkdirSync(MUSIC_UPLOAD_DIR, { recursive: true });
} catch (err) {
  console.error('[music] Could not create upload dir:', err.message);
}

function isBlockedMusicUrl(url) {
  const u = String(url || '').toLowerCase();
  return u.includes('youtube.com') || u.includes('youtu.be')
    || u.includes('spotify.com') || u.includes('open.spotify.com');
}

const DEFAULT_DISPLAY_OPTIONS = {
  showBadges: true,
  showLocalTime: true,
  showVerifiedBadge: true,
  showHandle: true,
  showPresence: true,
  showBio: true,
  showCustomLinks: true,
  showViews: true,
  showMemberSince: true,
  showRoleStats: true,
  showRoles: true,
  showSocials: true,
  showSpotifyWidget: true,
};

function normalizeDisplayOptions(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_DISPLAY_OPTIONS)) {
    out[key] = src[key] !== undefined ? !!src[key] : DEFAULT_DISPLAY_OPTIONS[key];
  }
  return out;
}

function referrerLabel(raw) {
  if (!raw) return 'Direct link';
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    if (host.includes('discord')) return 'Discord';
    if (host === 't.co' || host.includes('twitter') || host === 'x.com') return 'Twitter / X';
    if (host.includes('instagram')) return 'Instagram';
    if (host.includes('tiktok')) return 'TikTok';
    if (host.includes('youtube') || host === 'youtu.be') return 'YouTube';
    if (host.includes('reddit')) return 'Reddit';
    if (host.includes('cordfol')) return 'Cordfol';
    if (host.includes('google')) return 'Google';
    return host;
  } catch {
    return 'Direct link';
  }
}

app.get('/api/analytics', async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const [totals, daily, referrers, topClicks] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE type = 'profile_view')                                        AS views_all,
          COUNT(*) FILTER (WHERE type = 'profile_view' AND created_at >= NOW() - INTERVAL '7 days')  AS views_7d,
          COUNT(*) FILTER (WHERE type = 'profile_view' AND created_at >= NOW() - INTERVAL '14 days'
                                                       AND created_at <  NOW() - INTERVAL '7 days')  AS views_prev_7d,
          COUNT(*) FILTER (WHERE type = 'link_click')                                          AS link_clicks,
          COUNT(*) FILTER (WHERE type = 'role_click')                                          AS role_clicks
        FROM analytics_events
        WHERE user_id = $1
      `, [userId]),
      db.query(`
        SELECT date_trunc('day', created_at) AS day, COUNT(*) AS views
        FROM analytics_events
        WHERE user_id = $1 AND type = 'profile_view'
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY 1 ORDER BY 1
      `, [userId]),
      db.query(`
        SELECT COALESCE(metadata->>'referrer', '') AS referrer, COUNT(*) AS cnt
        FROM analytics_events
        WHERE user_id = $1 AND type = 'profile_view'
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY cnt DESC
        LIMIT 50
      `, [userId]),
      db.query(`
        SELECT type, COALESCE(metadata->>'label', metadata->>'platform', 'Unknown') AS label, COUNT(*) AS cnt
        FROM analytics_events
        WHERE user_id = $1 AND type IN ('link_click', 'role_click')
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1, 2 ORDER BY cnt DESC
        LIMIT 10
      `, [userId]),
    ]);

    // Collapse raw referrer URLs into friendly labels
    const refMap = new Map();
    for (const row of referrers.rows) {
      const label = referrerLabel(row.referrer);
      refMap.set(label, (refMap.get(label) || 0) + Number(row.cnt));
    }
    const refTotal = [...refMap.values()].reduce((a, b) => a + b, 0);
    const topReferrers = [...refMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, cnt]) => ({
        label,
        count: cnt,
        pct: refTotal ? Math.round((cnt / refTotal) * 100) : 0,
      }));

    // Fill last-7-days series including zero days
    const dayMs = 24 * 60 * 60 * 1000;
    const series = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * dayMs);
      const key = d.toISOString().slice(0, 10);
      const match = daily.rows.find(r => new Date(r.day).toISOString().slice(0, 10) === key);
      series.push({
        date: key,
        day: d.toLocaleDateString('en-US', { weekday: 'short' }),
        views: match ? Number(match.views) : 0,
      });
    }

    const t = totals.rows[0];
    const views7d = Number(t.views_7d);
    const viewsPrev = Number(t.views_prev_7d);
    const deltaPct = viewsPrev > 0
      ? Math.round(((views7d - viewsPrev) / viewsPrev) * 100)
      : (views7d > 0 ? 100 : 0);

    res.json({
      totals: {
        views: Number(t.views_all),
        views7d,
        viewsDeltaPct: deltaPct,
        linkClicks: Number(t.link_clicks),
        roleClicks: Number(t.role_clicks),
      },
      daily: series,
      referrers: topReferrers,
      topClicks: topClicks.rows.map(r => ({
        type: r.type,
        label: r.label,
        count: Number(r.cnt),
      })),
    });
  } catch (err) {
    console.error('[server] /api/analytics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public event tracking from profile pages (link/role clicks)
app.post('/api/analytics/event', async (req, res) => {
  try {
    const { slug, type, label, platform } = req.body || {};
    if (!slug || !['link_click', 'role_click', 'share'].includes(type)) {
      return res.status(400).json({ error: 'Invalid event' });
    }
    await db.query(`
      INSERT INTO analytics_events (id, user_id, type, metadata, created_at)
      SELECT gen_random_uuid(), u.id, $1, $2::jsonb, NOW()
      FROM users u WHERE u.slug = $3
    `, [
      type,
      JSON.stringify({
        label: String(label || '').slice(0, 100) || null,
        platform: String(platform || '').slice(0, 50) || null,
      }),
      String(slug).slice(0, 64),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[server] /api/analytics/event error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Public Stats + Showcase (landing page, cached 5 min) ─────────────────────
let publicStatsCache = { data: null, at: 0 };
app.get('/api/stats/public', async (req, res) => {
  try {
    if (publicStatsCache.data && Date.now() - publicStatsCache.at < 5 * 60 * 1000) {
      return res.json(publicStatsCache.data);
    }
    const [users, roles, views] = await Promise.all([
      db.query(`SELECT COUNT(*) AS n FROM users`),
      db.query(`SELECT COUNT(*) AS n FROM verified_roles`),
      db.query(`SELECT COUNT(*) AS n FROM analytics_events WHERE type = 'profile_view'`),
    ]);
    const data = {
      profiles: Number(users.rows[0].n),
      rolesVerified: Number(roles.rows[0].n),
      profileViews: Number(views.rows[0].n),
    };
    publicStatsCache = { data, at: Date.now() };
    res.json(data);
  } catch (err) {
    console.error('[server] /api/stats/public error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

let showcaseCache = { data: null, at: 0 };
app.get('/api/showcase', async (req, res) => {
  try {
    if (showcaseCache.data && Date.now() - showcaseCache.at < 5 * 60 * 1000) {
      return res.json(showcaseCache.data);
    }
    const rows = await db.query(`
      SELECT u.slug, COALESCE(u.display_name, u.discord_username) AS name,
             u.avatar_url,
             COUNT(vr.id) AS role_count,
             COALESCE(v.views, 0) AS views
      FROM users u
      LEFT JOIN verified_roles vr ON vr.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS views FROM analytics_events
        WHERE type = 'profile_view' GROUP BY user_id
      ) v ON v.user_id = u.id
      WHERE u.slug IS NOT NULL
      GROUP BY u.id, v.views
      ORDER BY COALESCE(v.views, 0) DESC, COUNT(vr.id) DESC
      LIMIT 6
    `);
    const data = {
      profiles: rows.rows.map(r => ({
        slug: r.slug,
        name: r.name || r.slug,
        avatarUrl: r.avatar_url || null,
        roleCount: Number(r.role_count),
        views: Number(r.views),
      })),
    };
    showcaseCache = { data, at: Date.now() };
    res.json(data);
  } catch (err) {
    console.error('[server] /api/showcase error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Server Status ──────────────────────────────────────────────────────────────
let botClient = null;

app.get('/api/status/servers', async (req, res) => {
  try {
    const botStatus = {
      online: botClient && botClient.user ? true : false,
      botName: botClient?.user?.tag || 'Offline',
      guilds: botClient?.guilds?.cache?.size || 0,
      ping: botClient?.ws?.ping || 0,
    };

    const dbStatus = {
      connected: true,
      lastCheck: new Date().toISOString(),
    };

    res.json({
      bot: botStatus,
      database: dbStatus,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[status] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Set Bot Client ─────────────────────────────────────────────────────────────
global.setBotClient = (client) => {
  botClient = client;
};

// ── Exclusive Status Page (Creator Only) ──────────────────────────────────────
const EXCLUSIVE_USER_ID = '1127435524022472805';

app.get('/api/status', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      console.log('[status] No userId in session');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userResult = await db.query(
      'SELECT discord_id FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rowCount === 0) {
      console.log('[status] User not found');
      return res.status(401).json({ error: 'User not found' });
    }

    const userDiscordId = userResult.rows[0].discord_id;
    console.log(`[status] Checking user ${userDiscordId} against ${EXCLUSIVE_USER_ID}`);

    if (userDiscordId !== EXCLUSIVE_USER_ID) {
      console.log('[status] User is not exclusive user');
      return res.status(403).json({ error: 'This feature is exclusive to the creator' });
    }

    const statusResult = await db.query(`
      SELECT status_title, status_description, status_links, status_visibility
      FROM user_metadata WHERE user_id = $1
    `, [userId]);

    if (statusResult.rowCount === 0) {
      return res.json({
        statusTitle: 'Building amazing things',
        statusDescription: 'Cordfol.io - Discord Identity, Verified.',
        statusLinks: [],
        statusVisibility: 'private'
      });
    }

    const status = statusResult.rows[0];
    res.json({
      statusTitle: status.status_title,
      statusDescription: status.status_description,
      statusLinks: status.status_links || [],
      statusVisibility: status.status_visibility || 'private'
    });

  } catch (err) {
    console.error('[server] /api/status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/status', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userResult = await db.query(
      'SELECT discord_id FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rowCount === 0 || userResult.rows[0].discord_id !== EXCLUSIVE_USER_ID) {
      return res.status(403).json({ error: 'This feature is exclusive to the creator' });
    }

    const { statusTitle, statusDescription, statusLinks, statusVisibility } = req.body;

    const existing = await db.query(
      'SELECT id FROM user_metadata WHERE user_id = $1',
      [userId]
    );

    if (existing.rowCount === 0) {
      await db.query(`
        INSERT INTO user_metadata (id, user_id, status_title, status_description, status_links, status_visibility)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
      `, [userId, statusTitle, statusDescription, statusLinks, statusVisibility]);
    } else {
      await db.query(`
        UPDATE user_metadata SET
          status_title = $1,
          status_description = $2,
          status_links = $3,
          status_visibility = $4,
          updated_at = NOW()
        WHERE user_id = $5
      `, [statusTitle, statusDescription, statusLinks, statusVisibility, userId]);
    }

    res.json({ ok: true });

  } catch (err) {
    console.error('[server] /api/status POST error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/status/public/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const userResult = await db.query(
      'SELECT u.id, u.discord_id FROM users u WHERE u.slug = $1',
      [slug]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    if (user.discord_id !== EXCLUSIVE_USER_ID) {
      return res.status(404).json({ error: 'Status page not found' });
    }

    const statusResult = await db.query(`
      SELECT status_title, status_description, status_links, status_visibility
      FROM user_metadata WHERE user_id = $1
    `, [user.id]);

    if (statusResult.rowCount === 0) {
      return res.status(404).json({ error: 'Status not configured' });
    }

    const status = statusResult.rows[0];
    if (status.status_visibility !== 'public') {
      return res.status(403).json({ error: 'This status page is private' });
    }

    res.json({
      statusTitle: status.status_title,
      statusDescription: status.status_description,
      statusLinks: status.status_links || []
    });

  } catch (err) {
    console.error('[server] /api/status/public error:', err);
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

// ── Admin Panel ────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Status Page ────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

// ── Legal Pages ────────────────────────────────────────────────────────────────
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.use('/api/admin', adminRouter);

// ── OG Image Cards (Discord/Twitter embed previews) ───────────────────────────
const { createOgRoute } = require('./og');
app.get('/og/:slug.png', createOgRoute(db));
app.get('/og/:slug', createOgRoute(db));

// ── QR code for profile links ─────────────────────────────────────────────────
const QRCode = require('qrcode');
const qrCache = new Map(); // slug:accent -> { buffer, expires }
app.get('/api/qr/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase().replace(/\.png$/, '').replace(/[^a-z0-9\-]/g, '').slice(0, 64);
  if (!slug) return res.status(404).send('Not found');

  try {
    const row = await db.query(`
      SELECT u.slug, t.accent_color FROM users u
      LEFT JOIN themes t ON t.id = u.theme_id
      WHERE u.slug = $1
    `, [slug]);
    if (row.rowCount === 0) return res.status(404).send('Not found');

    const accent = /^#[0-9a-fA-F]{6}$/.test(row.rows[0].accent_color || '')
      ? row.rows[0].accent_color
      : '#5865F2';

    const cacheKey = `${slug}:${accent}`;
    const cached = qrCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(cached.buffer);
    }

    const buffer = await QRCode.toBuffer(`https://cordfol.org/${slug}`, {
      type: 'png',
      width: 480,
      margin: 2,
      color: { dark: accent, light: '#0b0b10' },
      errorCorrectionLevel: 'M',
    });

    qrCache.set(cacheKey, { buffer, expires: Date.now() + 60 * 60 * 1000 });
    if (qrCache.size > 300) {
      const oldest = [...qrCache.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
      if (oldest) qrCache.delete(oldest[0]);
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (err) {
    console.error('[qr] generation failed:', err.message);
    res.status(500).send('QR generation failed');
  }
});

// ── Public Profile Page (with per-user OG tags for link previews) ────────────
let profileTemplate = null;
function getProfileTemplate() {
  if (!profileTemplate) {
    profileTemplate = fs.readFileSync(path.join(__dirname, 'public', 'profile.html'), 'utf8');
  }
  return profileTemplate;
}

function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/:slug', async (req, res) => {
  const reserved = ['api', 'dashboard', 'login', 'logout', 'static', 'status', 'admin', 'og', 'privacy', 'terms'];
  const slug = String(req.params.slug || '').toLowerCase();
  if (reserved.includes(slug)) {
    return res.status(404).send('Not found');
  }

  let html = getProfileTemplate();
  try {
    const row = await db.query(`
      SELECT discord_id, discord_username, display_name, bio, avatar_hash, avatar_url
      FROM users WHERE slug = $1
    `, [slug]);

    // Unclaimed handle → show the "this handle is available" page instead of a bare 404
    if (row.rowCount === 0 && /^[a-z0-9\-]{1,32}$/.test(slug)) {
      return res.status(404).sendFile(path.join(__dirname, 'public', 'claim.html'));
    }

    if (row.rowCount > 0) {
      const u = row.rows[0];
      const name = u.display_name || u.discord_username || slug;
      const bio = (u.bio || `${name}'s verified Discord profile on Cordfol.`).slice(0, 200);
      const pageUrl = `https://cordfol.org/${slug}`;
      const cardImage = `https://cordfol.org/og/${slug}.png`;

      const meta = [
        `<title>${escapeAttr(name)} — Cordfol</title>`,
        `<meta name="description" content="${escapeAttr(bio)}"/>`,
        `<link rel="canonical" href="${escapeAttr(pageUrl)}"/>`,
        `<meta property="og:type" content="profile"/>`,
        `<meta property="og:site_name" content="Cordfol"/>`,
        `<meta property="og:title" content="${escapeAttr(name)} — Cordfol"/>`,
        `<meta property="og:description" content="${escapeAttr(bio)}"/>`,
        `<meta property="og:url" content="${escapeAttr(pageUrl)}"/>`,
        `<meta property="og:image" content="${escapeAttr(cardImage)}"/>`,
        `<meta property="og:image:width" content="1200"/>`,
        `<meta property="og:image:height" content="630"/>`,
        `<meta name="twitter:card" content="summary_large_image"/>`,
        `<meta name="twitter:title" content="${escapeAttr(name)} — Cordfol"/>`,
        `<meta name="twitter:description" content="${escapeAttr(bio)}"/>`,
        `<meta name="twitter:image" content="${escapeAttr(cardImage)}"/>`,
        `<meta name="theme-color" content="#5865F2"/>`,
      ].join('\n  ');

      html = html.replace('<title>Cordfol Profile</title>', meta);
    }
  } catch (err) {
    console.error('[server] profile OG injection error:', err);
  }

  res.type('html').send(html);
});

// ── Start Server ──────────────────────────────────────────────────────────────
runMigrations(db)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] Running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('[server] Migration failed — cannot start:', err);
    process.exit(1);
  });

// ── Start Bot ─────────────────────────────────────────────────────────────────
botClient = require('./bot/index.js');

module.exports = app;