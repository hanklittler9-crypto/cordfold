// ─────────────────────────────────────────────────────────────────────────────
// Cordfol.io — OAuth2 Auth Handler (discord.js)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const crypto  = require('crypto');
const { Pool } = require('pg');

const router = express.Router();

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DATABASE_URL,
  ENCRYPTION_KEY,
} = process.env;

const DISCORD_API = 'https://discord.com/api/v10';
const SCOPES = ['identify', 'guilds', 'role_connections.write'].join('%20');

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const KEY = Buffer.from(ENCRYPTION_KEY, 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Route: GET /api/auth/discord ──────────────────────────────────────────────
router.get('/', (req, res) => {
  const state = generateState();

  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 5 * 60 * 1000
  });

  const url = [
    'https://discord.com/api/oauth2/authorize',
    `?client_id=${DISCORD_CLIENT_ID}`,
    `&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}`,
    '&response_type=code',
    `&scope=${SCOPES}`,
    `&state=${state}`,
    '&prompt=none',
  ].join('');

  res.redirect(url);
});

// ── Route: GET /api/auth/discord/callback ─────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect('/?error=denied');
  if (!state) return res.redirect('/?error=csrf');

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[auth] Token exchange failed:', tokenRes.status, errText);
      return res.redirect('/?error=token_exchange');
    }

    const tokenText = await tokenRes.text();
    const { access_token, refresh_token, expires_in, token_type } = JSON.parse(tokenText);
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000);

    const meRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `${token_type} ${access_token}` },
    });

    if (!meRes.ok) return res.redirect('/?error=identity');

    const userData = await meRes.json();
    const { id: discordId, username, discriminator, avatar, email } = userData;

    let baseSlug = username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
    let slug = baseSlug;
    let i = 0;

    while (true) {
      const exists = await db.query('SELECT 1 FROM users WHERE slug = $1', [slug]);
      if (exists.rowCount === 0) break;
      i++;
      slug = `${baseSlug}${i}`;
    }

    const result = await db.query(`
      INSERT INTO users
      (id, discord_id, discord_username, discriminator, avatar_hash, email,
       access_token, refresh_token, token_expires_at,
       slug, display_name, plan, created_at, updated_at)
      VALUES
      (gen_random_uuid(), $1, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10, 'FREE', NOW(), NOW())
      ON CONFLICT (discord_id)
      DO UPDATE SET
        discord_username = EXCLUDED.discord_username,
        discriminator    = EXCLUDED.discriminator,
        avatar_hash      = EXCLUDED.avatar_hash,
        email            = COALESCE(EXCLUDED.email, users.email),
        access_token     = EXCLUDED.access_token,
        refresh_token    = EXCLUDED.refresh_token,
        token_expires_at = EXCLUDED.token_expires_at,
        updated_at       = NOW()
      RETURNING id, slug, plan
    `, [
      discordId, username, discriminator, avatar, email,
      encrypt(access_token), encrypt(refresh_token), tokenExpiresAt,
      slug, username
    ]);

    const user = result.rows[0];

    req.session.userId = user.id;
    req.session.discordId = discordId;
    req.session.plan = user.plan;

    req.session.save(err => {
      if (err) {
        console.error('[auth] Session save error:', err);
        return res.redirect('/?error=session');
      }
      const sid = req.sessionID;
      console.log('[auth] Session saved, sid:', sid);
      res.redirect(`https://dashboard.cordfol.org/dashboard.html?sid=${encodeURIComponent(sid)}`);
    });

  } catch (err) {
    console.error('[auth] OAuth error:', err);
    res.redirect('/?error=server');
  }
});

// ── Route: GET /api/auth/me ───────────────────────────────────────────────────
router.get('/me', async (req, res) => {
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
        discordId: u.discord_id,
        username: u.discord_username,
        avatarUrl: u.avatar_hash
          ? `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar_hash}.png`
          : null,
        slug: u.slug,
        displayName: u.display_name,
        bio: u.bio,
        plan: u.plan,
      }
    });

  } catch (err) {
    console.error('[auth] /me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Route: POST /api/auth/logout ──────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to sign out' });
    }
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

module.exports = router;