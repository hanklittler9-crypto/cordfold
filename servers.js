function guildIconUrl(guildId, hash, size = 128) {
  if (!guildId || !hash) return null;
  const ext = String(hash).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.${ext}?size=${size}`;
}

function liveGuild(botClient, guildId) {
  const g = botClient?.guilds?.cache?.get(String(guildId));
  if (!g) return null;
  let online = 0;
  try {
    online = g.presences?.cache?.filter((p) => p.status && p.status !== 'offline').size || 0;
  } catch { /* ignore */ }
  const iconUrl = typeof g.iconURL === 'function'
    ? g.iconURL({ size: 256 })
    : null;
  return {
    botIn: true,
    name: g.name,
    iconUrl,
    members: g.memberCount || 0,
    online,
    description: g.description || null,
    vanity: g.vanityURLCode || null,
  };
}

function inviteFor(guildId, live, env = process.env) {
  if (String(guildId) === String(env.CORDFOL_GUILD_ID || '1537671204465541182')) {
    return env.DISCORD_INVITE_URL || 'https://discord.gg/3PCM24s9WT';
  }
  if (live?.vanity) return `https://discord.gg/${live.vanity}`;
  return null;
}

function createServersRouter({ db, botClientRef, discordAvatarFromUser }) {
  const express = require('express');
  const router = express.Router();
  let listCache = { at: 0, data: null };

  router.get('/', async (req, res) => {
    try {
      if (listCache.data && Date.now() - listCache.at < 45 * 1000) {
        res.set('Cache-Control', 'public, max-age=30');
        return res.json(listCache.data);
      }
      const rows = await db.query(`
        SELECT
          vr.guild_id,
          MAX(vr.guild_name) AS guild_name,
          MAX(vr.guild_icon_hash) AS guild_icon_hash,
          COUNT(DISTINCT vr.user_id)::int AS people,
          COUNT(*)::int AS roles
        FROM verified_roles vr
        WHERE vr.is_active = true AND vr.is_public = true
          AND vr.guild_id IS NOT NULL AND vr.guild_id <> ''
        GROUP BY vr.guild_id
        ORDER BY COUNT(DISTINCT vr.user_id) DESC, COUNT(*) DESC
        LIMIT 80
      `);

      const servers = rows.rows.map((r) => {
        const live = liveGuild(botClientRef(), r.guild_id);
        return {
          id: r.guild_id,
          name: live?.name || r.guild_name || 'Discord server',
          iconUrl: live?.iconUrl || guildIconUrl(r.guild_id, r.guild_icon_hash, 128),
          people: r.people,
          roles: r.roles,
          members: live?.members || null,
          online: live?.online || null,
          botIn: !!live,
          inviteUrl: inviteFor(r.guild_id, live),
        };
      });

      const data = {
        servers,
        totals: {
          servers: servers.length,
          people: servers.reduce((n, s) => n + s.people, 0),
          withBot: servers.filter((s) => s.botIn).length,
        },
      };
      listCache = { at: Date.now(), data };
      res.set('Cache-Control', 'public, max-age=30');
      res.json(data);
    } catch (err) {
      console.error('[servers] list:', err);
      res.status(500).json({ error: 'Failed to list servers' });
    }
  });

  router.get('/:guildId', async (req, res) => {
    try {
      const guildId = String(req.params.guildId || '').replace(/\D/g, '');
      if (!/^\d{17,20}$/.test(guildId)) {
        return res.status(404).json({ error: 'Server not found' });
      }

      const meta = await db.query(`
        SELECT
          MAX(guild_name) AS guild_name,
          MAX(guild_icon_hash) AS guild_icon_hash,
          COUNT(DISTINCT user_id)::int AS people,
          COUNT(*)::int AS roles
        FROM verified_roles
        WHERE guild_id = $1 AND is_active = true AND is_public = true
      `, [guildId]);

      const live = liveGuild(botClientRef(), guildId);
      const peopleCount = Number(meta.rows[0]?.people || 0);
      if (!live && !peopleCount) {
        return res.status(404).json({ error: 'No verified identities on this server yet.' });
      }

      const [people, roles] = await Promise.all([
        db.query(`
          SELECT
            u.slug, u.display_name, u.discord_username, u.plan,
            u.discord_id, u.avatar_hash, u.avatar_url, u.bio,
            COUNT(vr.role_id)::int AS role_count
          FROM users u
          JOIN verified_roles vr ON vr.user_id = u.id
          WHERE vr.guild_id = $1 AND vr.is_active = true AND vr.is_public = true
            AND u.slug IS NOT NULL
          GROUP BY u.id
          ORDER BY COUNT(vr.role_id) DESC, u.display_name ASC
          LIMIT 48
        `, [guildId]),
        db.query(`
          SELECT
            role_id,
            MAX(role_name) AS role_name,
            MAX(role_color) AS role_color,
            COUNT(*)::int AS holders
          FROM verified_roles
          WHERE guild_id = $1 AND is_active = true AND is_public = true
            AND role_id <> guild_id
          GROUP BY role_id
          ORDER BY COUNT(*) DESC
          LIMIT 18
        `, [guildId]),
      ]);

      res.set('Cache-Control', 'public, max-age=20');
      res.json({
        id: guildId,
        name: live?.name || meta.rows[0]?.guild_name || 'Discord server',
        iconUrl: live?.iconUrl || guildIconUrl(guildId, meta.rows[0]?.guild_icon_hash, 256),
        description: live?.description || null,
        people: peopleCount,
        roles: Number(meta.rows[0]?.roles || 0),
        members: live?.members || null,
        online: live?.online || null,
        botIn: !!live,
        inviteUrl: inviteFor(guildId, live),
        stack: roles.rows.map((r) => ({
          id: r.role_id,
          name: /^\d{16,22}$/.test(String(r.role_name || '')) ? 'Role' : r.role_name,
          color: r.role_color ? `#${Number(r.role_color).toString(16).padStart(6, '0')}` : null,
          holders: r.holders,
        })),
        identities: people.rows.map((u) => ({
          slug: u.slug,
          name: u.display_name || u.discord_username,
          bio: u.bio,
          pro: String(u.plan || '').toUpperCase() === 'PRO',
          roleCount: u.role_count,
          avatarUrl: u.avatar_url || discordAvatarFromUser(u),
        })),
      });
    } catch (err) {
      console.error('[servers] one:', err);
      res.status(500).json({ error: 'Failed to load server' });
    }
  });

  return router;
}

async function roomsForProfile(db, { userId, visitorId, discordAvatarFromUser, orgRoleIds = [] }) {
  const mine = await db.query(`
    WITH mine AS (
      SELECT guild_id,
        MAX(guild_name) AS guild_name,
        MAX(guild_icon_hash) AS guild_icon_hash
      FROM verified_roles
      WHERE user_id = $1 AND is_active = true AND is_public = true
        AND guild_id IS NOT NULL AND guild_id <> ''
      GROUP BY guild_id
    ),
    counts AS (
      SELECT vr.guild_id, COUNT(DISTINCT vr.user_id)::int AS people
      FROM verified_roles vr
      JOIN mine ON mine.guild_id = vr.guild_id
      WHERE vr.is_active = true AND vr.is_public = true
      GROUP BY vr.guild_id
    )
    SELECT mine.guild_id, mine.guild_name, mine.guild_icon_hash, counts.people
    FROM mine
    JOIN counts ON counts.guild_id = mine.guild_id
    ORDER BY counts.people DESC, mine.guild_name ASC
    LIMIT 8
  `, [userId]);

  let shared = new Set();
  if (visitorId && String(visitorId) !== String(userId)) {
    const overlap = await db.query(`
      SELECT DISTINCT a.guild_id
      FROM verified_roles a
      JOIN verified_roles b ON a.guild_id = b.guild_id
      WHERE a.user_id = $1 AND b.user_id = $2
        AND a.is_active = true AND a.is_public = true
        AND b.is_active = true AND b.is_public = true
    `, [userId, visitorId]);
    shared = new Set(overlap.rows.map((r) => r.guild_id));
  }

  const guildIds = mine.rows.map((r) => r.guild_id);
  let faces = [];
  if (guildIds.length) {
    const people = await db.query(`
      SELECT DISTINCT ON (u.id)
        u.slug, u.display_name, u.discord_username, u.avatar_url, u.avatar_hash, u.discord_id
      FROM verified_roles vr
      JOIN users u ON u.id = vr.user_id
      WHERE vr.guild_id = ANY($1::text[])
        AND vr.user_id <> $2
        AND vr.is_active = true AND vr.is_public = true
        AND u.slug IS NOT NULL AND u.slug <> ''
      ORDER BY u.id
      LIMIT 6
    `, [guildIds, userId]);
    faces = people.rows.map((u) => ({
      slug: u.slug,
      name: u.display_name || u.discord_username,
      avatarUrl: u.avatar_url || (typeof discordAvatarFromUser === 'function' ? discordAvatarFromUser(u) : null),
    }));
  }

  let orgs = [];
  if (orgRoleIds.length) {
    const hit = await db.query(`
      SELECT role_id, MAX(role_name) AS role_name
      FROM verified_roles
      WHERE user_id = $1 AND is_active = true AND is_public = true
        AND role_id = ANY($2::text[])
      GROUP BY role_id
    `, [userId, orgRoleIds]);
    orgs = hit.rows.map((r) => ({
      id: r.role_id,
      name: r.role_name,
    }));
  }

  return {
    servers: mine.rows.map((r) => ({
      id: r.guild_id,
      name: r.guild_name || 'Discord server',
      iconUrl: guildIconUrl(r.guild_id, r.guild_icon_hash, 64),
      people: r.people,
      shared: shared.has(r.guild_id),
    })),
    sharedCount: shared.size,
    faces,
    orgs,
  };
}

module.exports = { createServersRouter, guildIconUrl, roomsForProfile };
