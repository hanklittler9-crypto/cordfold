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
  SESSION_SECRET,
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
  console.log('[auth] /api/auth/discord/callback HIT', req.query);
  const { code, state, error } = req.query;

  if (error) {
    console.warn('[auth] User denied OAuth:', error);
    return res.redirect('/?error=denied');
  }

  if (!state) {
    console.warn('[auth] No state provided');
    return res.redirect('/?error=csrf');
  }
  
  try {
    console.log('[auth] Step 1: Exchange code for tokens');
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
      const err = await tokenRes.json();
      console.error('[auth] Token exchange failed:', err);
      return res.redirect('/?error=token_exchange');
    }

    const { access_token, refresh_token, expires_in, token_type } = await tokenRes.json();
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000);
    console.log('[auth] Step 2: Fetch user identity');

    const meRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `${token_type} ${access_token}` },
    });

    if (!meRes.ok) {
      console.error('[auth] Failed to fetch user identity');
      return res.redirect('/?error=identity');
    }

    const discordUser = await meRes.json();
    console.log('[auth] Discord user:', discordUser);
    const { id: discordId, username, discriminator, avatar, email } = discordUser;

    let baseSlug = username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
    let slug = baseSlug;
    let attempt = 0;

    while (true) {
      const conflict = await db.query('SELECT id FROM users WHERE slug = $1', [slug]);
      if (conflict.rowCount === 0) break;
      attempt++;
      slug = `${baseSlug}${attempt}`;
    }
    console.log('[auth] Step 3: Slug generated:', slug);

    const encryptedAccess  = encrypt(access_token);
    const encryptedRefresh = encrypt(refresh_token);

    console.log('[auth] Step 4: Upsert user');
    const upsertResult = await db.query(`
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
      encryptedAccess, encryptedRefresh, tokenExpiresAt,
      slug, username,
    ]);

    const user = upsertResult.rows[0];
    console.log('[auth] Step 5: User upserted:', user);

    req.session.userId    = user.id;
    req.session.discordId = discordId;
    req.session.plan      = user.plan;
    console.log('[auth] Step 6: Session set:', req.session);

    console.log('[auth] Step 7: Triggering guild scan');
    triggerGuildScan(user.id, access_token, token_type).catch(err =>
      console.error('[auth] Background guild scan failed:', err)
    );

    console.log('[auth] Step 8: Saving session and redirecting to dashboard');
    req.session.save(err => {
      if (err) {
        console.error('[auth] Session save error:', err);
        return res.redirect('/?error=session');
      }
      res.redirect('https://dashboard.cordfol.org/dashboard.html');
    });

  } catch (err) {
    console.error('[auth] OAuth callback error:', err);
    res.redirect('/?error=server'); 
  // ── Route: GET /api/auth/me ───────────────────────────────────────────────
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
};

// ── Route: POST /api/auth/logout ──────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  req.session.destroy((err) => {
    if (err) {
      console.error('[auth] Session destroy error:', err);
      return res.status(500).json({ error: 'Failed to sign out' });
    }
    res.clearCookie('connect.sid');
    console.log(`[auth] User ${userId} signed out`);
    res.json({ ok: true, redirectTo: '/' });
  });
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
    console.error('[auth] /me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Token Refresh Helper ──────────────────────────────────────────────────────
async function getValidAccessToken(userId) {
  const row = await db.query(
    'SELECT access_token, refresh_token, token_expires_at FROM users WHERE id = $1',
    [userId]
  );
  if (row.rowCount === 0) throw new Error('User not found');

  const { access_token, refresh_token, token_expires_at } = row.rows[0];
  const expiresAt = new Date(token_expires_at);
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);

  if (expiresAt > oneHourFromNow) {
    return decrypt(access_token);
  }

  console.log(`[auth] Refreshing token for user ${userId}`);
  const refreshRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: decrypt(refresh_token),
    }),
  });

  if (!refreshRes.ok) {
    throw new Error('Token refresh failed — user must re-authenticate');
  }

  const { access_token: newAccess, refresh_token: newRefresh, expires_in } = await refreshRes.json();
  const newExpiry = new Date(Date.now() + expires_in * 1000);

  await db.query(`
    UPDATE users
    SET access_token = $1, refresh_token = $2, token_expires_at = $3, updated_at = NOW()
    WHERE id = $4
  `, [encrypt(newAccess), encrypt(newRefresh), newExpiry, userId]);

  return newAccess;
}

// ── Background Guild Scan ─────────────────────────────────────────────────────
async function triggerGuildScan(userId, accessToken, tokenType) {
  const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds?limit=200`, {
    headers: { Authorization: `${tokenType} ${accessToken}` },
  });

  if (!guildsRes.ok) {
    console.warn(`[auth] Could not fetch guilds for user ${userId}:`, guildsRes.status);
    return;
  }

  const guilds = await guildsRes.json();
  console.log(`[auth] Scanning ${guilds.length} guilds for user ${userId}`);

  for (const guild of guilds) {
    await new Promise(r => setTimeout(r, 150));

    try {
      const memberRes = await fetch(
        `${DISCORD_API}/users/@me/guilds/${guild.id}/member`,
        { headers: { Authorization: `${tokenType} ${accessToken}` } }
      );

      if (!memberRes.ok) continue;

      const member = await memberRes.json();
      if (!member.roles || member.roles.length === 0) continue;

      for (const roleId of member.roles) {
        await db.query(`
          INSERT INTO verified_roles
            (id, user_id, guild_id, guild_name, guild_icon_hash, role_id, role_name,
             verified_at, last_checked_at, is_active, proof_type, is_public, display_order)
          VALUES
            (gen_random_uuid(), $1, $2, $3, $4, $5, $6,
             NOW(), NOW(), true, 'OAUTH', true, 0)
          ON CONFLICT (user_id, guild_id, role_id)
          DO UPDATE SET
            is_active = true,
            last_checked_at = NOW(),
            guild_name = EXCLUDED.guild_name
        `, [userId, guild.id, guild.name, guild.icon, roleId, roleId]);
      }

    } catch (err) {
      console.warn(`[auth] Error scanning guild ${guild.id}:`, err.message);
    }
  }

  console.log(`[auth] Guild scan complete for user ${userId}`);

  try {
    const botGuildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
    });

    if (botGuildsRes.ok) {
      const botGuilds = await botGuildsRes.json();
      const botGuildIds = new Set(botGuilds.map(g => g.id));

      for (const guild of guilds) {
        if (botGuildIds.has(guild.id)) {
          await new Promise(r => setTimeout(r, 100));
          const rolesRes = await fetch(`${DISCORD_API}/guilds/${guild.id}/roles`, {
            headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` },
          });

          if (rolesRes.ok) {
            const roles = await rolesRes.json();
            const roleMap = new Map(roles.map(r => [r.id, r.name]));
            const userRolesRes = await db.query(
              'SELECT role_id FROM verified_roles WHERE user_id = $1 AND guild_id = $2 AND proof_type = $3',
              [userId, guild.id, 'OAUTH']
            );
            for (const row of userRolesRes.rows) {
              const roleName = roleMap.get(row.role_id) || row.role_id;
              await db.query(
                'UPDATE verified_roles SET role_name = $1 WHERE user_id = $2 AND guild_id = $3 AND role_id = $4',
                [roleName, userId, guild.id, row.role_id]
              );
            }
          }
        }
      }
      console.log(`[auth] Role names updated for user ${userId} in ${botGuildIds.size} bot-present guilds`);
    }
  } catch (err) {
    console.warn(`[auth] Error updating role names for user ${userId}:`, err.message);
  }
}
module.exports = { router, getValidAccessToken}})}})