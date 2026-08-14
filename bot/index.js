// ─────────────────────────────────────────────────────────────────────────────
// Cordfol.io — Server Bot (bot/index.js)
// Profile verify/lookup (global) + Cordfol guild ops (status/announce/community)
// Prefix: .  (override with BOT_PREFIX)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  Partials,
} = require('discord.js');
const { Pool } = require('pg');
const statusStore = require('./status-store');

const {
  BOT_TOKEN,
  BOT_CLIENT_ID,
  DATABASE_URL,
  DASHBOARD_URL,
} = process.env;

const CORDFOL_GUILD_ID = process.env.CORDFOL_GUILD_ID || '1537671204465541182';
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || '';
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || '';
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '';
const BOT_PREFIX = (process.env.BOT_PREFIX || '.').trim() || '.';
const ADMIN_ROLE_IDS = (process.env.ADMIN_ROLE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DASHBOARD_LOGIN_URL = DASHBOARD_URL || 'https://dashboard.cordfol.org/dashboard';
const PUBLIC_BASE_URL = (() => {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  try {
    const dashboardUrl = new URL(DASHBOARD_LOGIN_URL);
    return `${dashboardUrl.protocol}//${dashboardUrl.host.replace(/^dashboard\./, '')}`;
  } catch { return 'https://cordfol.org'; }
})();
const PUBLIC_HOST = (() => {
  try { return new URL(PUBLIC_BASE_URL).host; }
  catch { return 'cordfol.org'; }
})();

function buildProfileUrl(slug) {
  return `${PUBLIC_BASE_URL}/${slug}`;
}

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

const EXCLUSIVE_USER_ID = '1127435524022472805';

const COLORS = {
  brand: 0xc84dff,
  discord: 0x5865F2,
  up: 0x3dd68c,
  degraded: 0xf0b429,
  down: 0xff4d6d,
  maintenance: 0xc84dff,
  error: 0xFF6B6B,
};

const STATE_META = {
  up: { label: 'Operational', emoji: '🟢', color: COLORS.up },
  degraded: { label: 'Degraded', emoji: '🟡', color: COLORS.degraded },
  down: { label: 'Outage', emoji: '🔴', color: COLORS.down },
  maintenance: { label: 'Maintenance', emoji: '🛠️', color: COLORS.maintenance },
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.GuildMember],
});

// Cooldown management (5 minute cooldown per user per guild)
const verifyCooldowns = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

function getCooldownKey(userId, guildId) {
  return `${userId}:${guildId}`;
}

function checkCooldown(userId, guildId) {
  const key = getCooldownKey(userId, guildId);
  const now = Date.now();
  const expirationTime = verifyCooldowns.get(key);

  if (expirationTime && now < expirationTime) {
    return Math.ceil((expirationTime - now) / 1000);
  }

  verifyCooldowns.set(key, now + COOLDOWN_MS);
  return null;
}

// ── Permissions ───────────────────────────────────────────────────────────────

function isCordfolGuild(guildId) {
  return guildId && String(guildId) === String(CORDFOL_GUILD_ID);
}

function memberHasAdminPerm(member) {
  const perms = member?.permissions;
  if (!perms) return false;
  try {
    if (typeof perms.has === 'function') {
      return perms.has(PermissionFlagsBits.Administrator);
    }
    return new PermissionsBitField(perms).has(PermissionFlagsBits.Administrator);
  } catch {
    return false;
  }
}

function memberHasAdminRole(member, roleId) {
  if (!member?.roles) return false;
  if (member.roles.cache?.has?.(roleId)) return true;
  if (Array.isArray(member.roles)) return member.roles.includes(roleId);
  if (typeof member.roles.includes === 'function') return member.roles.includes(roleId);
  return false;
}

function memberIsOps(member, userId) {
  if (userId === EXCLUSIVE_USER_ID) return true;
  if (!member) return false;
  if (member.guild?.ownerId === userId) return true;
  if (memberHasAdminPerm(member)) return true;
  if (ADMIN_ROLE_IDS.length && ADMIN_ROLE_IDS.some((id) => memberHasAdminRole(member, id))) return true;
  return false;
}

async function resolveMember(guild, userId) {
  if (!guild) return null;
  try {
    return guild.members.cache.get(userId) || await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

async function assertOps(interactionOrMessage) {
  const guild = interactionOrMessage.guild;
  const user = interactionOrMessage.user || interactionOrMessage.author;
  const member = interactionOrMessage.member || await resolveMember(guild, user.id);
  if (!isCordfolGuild(guild?.id)) {
    return { ok: false, reply: '❌ This command is only available in the Cordfol server.' };
  }
  if (!memberIsOps(member, user.id)) {
    return { ok: false, reply: '❌ Only Cordfol admins can use this command.' };
  }
  return { ok: true, member, user };
}

// ── Embeds ────────────────────────────────────────────────────────────────────

function statusEmbed(status, { title } = {}) {
  const meta = STATE_META[status.state] || STATE_META.up;
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(title || `${meta.emoji} Cordfol Status — ${meta.label}`)
    .setDescription(status.message || '_No details._')
    .addFields({ name: 'State', value: `\`${status.state}\``, inline: true })
    .setFooter({ text: `${PUBLIC_HOST} · System status` })
    .setTimestamp(status.updatedAt ? new Date(status.updatedAt) : new Date());

  if (status.updatedBy) {
    embed.addFields({ name: 'Updated by', value: status.updatedBy, inline: true });
  }
  return embed;
}

function announceEmbed({ title, description, color }) {
  return new EmbedBuilder()
    .setColor(color ?? COLORS.brand)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: `${PUBLIC_HOST} · Announcement` })
    .setTimestamp();
}

function helpEmbed() {
  const embed = new EmbedBuilder()
    .setColor(COLORS.discord)
    .setTitle('Cordfol Bot Help')
    .setDescription(
      `Verified Discord identity for **${PUBLIC_HOST}**.\n` +
      `Text prefix: \`${BOT_PREFIX}\` (also works as slash commands where available).`
    )
    .addFields(
      {
        name: 'Global',
        value: [
          `\`/verify\` · \`${BOT_PREFIX}verify\` — sync roles to your profile`,
          `\`/cordfol\` · \`${BOT_PREFIX}cordfol\` — your profile link`,
          `\`/whois\` · \`${BOT_PREFIX}whois @user\` — look up a profile`,
          `\`/help\` · \`${BOT_PREFIX}help\` — this message`,
          `\`${BOT_PREFIX}ping\` — latency check`,
        ].join('\n'),
      }
    )
    .setFooter({ text: `${PUBLIC_HOST} — Discord Identity, Verified.` });

  embed.addFields({
    name: 'Cordfol server (admins)',
    value: [
      `\`/status\` · \`${BOT_PREFIX}status\` — view site status`,
      `\`/status set\` · \`${BOT_PREFIX}status <up|down|degraded|maintenance> [msg]\``,
      `\`/announce\` · \`${BOT_PREFIX}announce <message>\``,
      `\`/maintenance\` · \`${BOT_PREFIX}maintenance [message]\``,
      `\`/outage\` · \`${BOT_PREFIX}outage [message]\``,
      `\`/broadcast\` · \`${BOT_PREFIX}broadcast <message>\` — status channel`,
    ].join('\n'),
  });

  return embed;
}

// ── Channel helpers ───────────────────────────────────────────────────────────

async function sendToChannel(channelId, payload) {
  if (!channelId) return { ok: false, error: 'Channel ID not configured.' };
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return { ok: false, error: 'Configured channel is not a text channel.' };
    }
    const msg = await channel.send(payload);
    return { ok: true, message: msg, channel };
  } catch (err) {
    console.error('[bot] sendToChannel error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function setAndBroadcastStatus({ state, message, user, alsoAnnounce = false }) {
  const status = statusStore.writeStatus({
    state,
    message,
    updatedBy: user.username || user.tag || String(user.id),
    updatedById: user.id,
  });

  const embed = statusEmbed(status);
  const results = [];

  if (STATUS_CHANNEL_ID) {
    results.push(await sendToChannel(STATUS_CHANNEL_ID, { embeds: [embed] }));
  }

  if (alsoAnnounce && ANNOUNCE_CHANNEL_ID && ANNOUNCE_CHANNEL_ID !== STATUS_CHANNEL_ID) {
    const meta = STATE_META[state] || STATE_META.up;
    results.push(await sendToChannel(ANNOUNCE_CHANNEL_ID, {
      embeds: [announceEmbed({
        title: `${meta.emoji} ${meta.label}`,
        description: status.message,
        color: meta.color,
      })],
    }));
  } else if (alsoAnnounce && ANNOUNCE_CHANNEL_ID && !STATUS_CHANNEL_ID) {
    results.push(await sendToChannel(ANNOUNCE_CHANNEL_ID, { embeds: [embed] }));
  }

  return { status, results };
}

// ── Slash command definitions ─────────────────────────────────────────────────

const globalCommands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Sync your Cordfol.io profile with your roles in this server')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('cordfol')
    .setDescription('Get your Cordfol.io profile link')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('whois')
    .setDescription('Look up a user\'s verified Cordfol.io profile')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('The Discord user to look up').setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show Cordfol bot commands')
    .toJSON(),
];

const guildCommands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('View or update Cordfol site status')
    .addSubcommand((sub) =>
      sub.setName('view').setDescription('Show the current declared site status')
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set site status (admins)')
        .addStringOption((opt) =>
          opt
            .setName('state')
            .setDescription('Status state')
            .setRequired(true)
            .addChoices(
              { name: 'up', value: 'up' },
              { name: 'degraded', value: 'degraded' },
              { name: 'down', value: 'down' },
              { name: 'maintenance', value: 'maintenance' }
            )
        )
        .addStringOption((opt) =>
          opt.setName('message').setDescription('Status details').setRequired(false)
        )
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post an announcement to the announce channel (admins)')
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Announcement text').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('title').setDescription('Optional title').setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('maintenance')
    .setDescription('Mark site as under maintenance and announce (admins)')
    .addStringOption((opt) =>
      opt.setName('message').setDescription('What is happening').setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('outage')
    .setDescription('Mark site as down/outage and announce (admins)')
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Outage details').setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('broadcast')
    .setDescription('Post a message to the status channel (admins)')
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Broadcast text').setRequired(true)
    )
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log('[bot] Registering global slash commands...');
    await rest.put(Routes.applicationCommands(BOT_CLIENT_ID), { body: globalCommands });
    console.log(`[bot] Global commands registered (${globalCommands.length}).`);

    if (CORDFOL_GUILD_ID) {
      console.log(`[bot] Registering Cordfol guild commands for ${CORDFOL_GUILD_ID}...`);
      await rest.put(
        Routes.applicationGuildCommands(BOT_CLIENT_ID, CORDFOL_GUILD_ID),
        { body: guildCommands }
      );
      console.log(`[bot] Guild commands registered (${guildCommands.length}).`);
    } else {
      console.warn('[bot] CORDFOL_GUILD_ID missing — skipped guild command registration.');
    }
  } catch (err) {
    console.error('[bot] Failed to register commands:', err);
  }
}

// ── Shared command logic ──────────────────────────────────────────────────────

async function handleVerify({ user, guildId, guild, reply, defer }) {
  if (!guildId) {
    return reply({ content: '❌ This command can only be used inside a server.', ephemeral: true });
  }

  const cooldownSeconds = checkCooldown(user.id, guildId);
  if (cooldownSeconds) {
    return reply({
      content: `⏳ You're verifying too quickly! Please wait **${cooldownSeconds}s** before verifying again.`,
      ephemeral: true,
    });
  }

  await defer({ ephemeral: true });

  try {
    const userRow = await db.query(
      'SELECT id, slug, display_name FROM users WHERE discord_id = $1',
      [user.id]
    );

    if (userRow.rowCount === 0) {
      return reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.discord)
            .setTitle('You don\'t have a Cordfol.io account yet')
            .setDescription(`Log in at **[${PUBLIC_HOST}](${DASHBOARD_LOGIN_URL})** to create your verified profile.`)
            .setFooter({ text: `${PUBLIC_HOST} — Discord Identity, Verified.` }),
        ],
        ephemeral: true,
      });
    }

    const cordfolUser = userRow.rows[0];

    let resolvedGuild = guild;
    try {
      resolvedGuild = guild || await client.guilds.fetch(guildId);
    } catch (err) {
      console.error('[bot] Failed to fetch guild:', err);
      return reply({ content: '❌ I couldn\'t connect to this server. Please try again.', ephemeral: true });
    }

    let member;
    try {
      member = await resolvedGuild.members.fetch(user.id);
    } catch (err) {
      console.error('[bot] Failed to fetch member:', err);
      return reply({
        content: '❌ I couldn\'t find you in this server. Make sure you\'re a member and the bot has permission to access members.',
        ephemeral: true,
      });
    }

    const roles = member.roles.cache
      .filter((r) => !r.managed && r.id !== resolvedGuild.id)
      .map((r) => ({ id: r.id, name: r.name, color: r.color || 0 }));

    if (roles.length === 0) {
      return reply({
        content: '⚠️ You don\'t have any assignable roles in this server. Only manual roles (not bot roles) can be verified.',
        ephemeral: true,
      });
    }

    const values = roles.map((_role, idx) =>
      `(gen_random_uuid(), $1, $2, $3, $4, $${5 + (idx * 3)}, $${6 + (idx * 3)}, $${7 + (idx * 3)})`
    ).join(',');

    const params = [cordfolUser.id, resolvedGuild.id, resolvedGuild.name, resolvedGuild.icon];
    roles.forEach((role) => {
      params.push(role.id, role.name, role.color);
    });

    await db.query(`
      INSERT INTO verified_roles
        (id, user_id, guild_id, guild_name, guild_icon_hash, role_id, role_name, role_color,
         verified_at, last_checked_at, is_active, proof_type, is_public, display_order)
      VALUES ${values}
      ON CONFLICT (user_id, guild_id, role_id)
      DO UPDATE SET
        role_name = EXCLUDED.role_name,
        role_color = EXCLUDED.role_color,
        is_active = true,
        last_checked_at = NOW(),
        proof_type = 'BOT'
    `, params);

    const roleList = roles.slice(0, 5).map((r) => `• **${r.name}**`).join('\n');
    const extra = roles.length > 5 ? `\n_...and ${roles.length - 5} more_` : '';

    return reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00FFB2)
          .setTitle('✅ Roles verified with bot-level proof!')
          .setDescription(
            `Your **${roles.length}** role${roles.length !== 1 ? 's' : ''} in **${resolvedGuild.name}** have been added to your Cordfol.io profile:\n\n${roleList}${extra}\n\n🔗 [View your profile](${buildProfileUrl(cordfolUser.slug)})`
          )
          .setFooter({ text: `${PUBLIC_HOST} — These roles cannot be faked.` }),
      ],
      ephemeral: true,
    });
  } catch (err) {
    console.error('[bot] /verify error:', err.message);
    return reply({
      content: '❌ Something went wrong while verifying your roles. Please try again later or contact support.',
      ephemeral: true,
    });
  }
}

async function handleCordfol({ user, reply, defer }) {
  await defer({ ephemeral: true });

  try {
    const row = await db.query(
      'SELECT slug, display_name, avatar_url, social_links FROM users WHERE discord_id = $1',
      [user.id]
    );

    if (row.rowCount === 0) {
      return reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.error)
            .setTitle('No Cordfol.io account found')
            .setDescription(`Create one at **[${PUBLIC_HOST}](${DASHBOARD_LOGIN_URL})**`)
            .setFooter({ text: 'Link your Discord account during signup' }),
        ],
        ephemeral: true,
      });
    }

    const { slug, display_name, avatar_url, social_links } = row.rows[0];
    const profileUrl = buildProfileUrl(slug);

    const serversRow = await db.query(
      'SELECT DISTINCT guild_name, guild_id, guild_icon_hash FROM verified_roles WHERE user_id = (SELECT id FROM users WHERE discord_id = $1) AND is_active = true',
      [user.id]
    );

    const embed = new EmbedBuilder()
      .setColor(COLORS.discord)
      .setTitle(`${display_name}'s Cordfol.io Profile`)
      .setURL(profileUrl)
      .setDescription(`🔗 **[${PUBLIC_HOST}/${slug}](${profileUrl})**`);

    if (user.id === EXCLUSIVE_USER_ID) {
      embed.setDescription(`🔗 **[${PUBLIC_HOST}/${slug}](${profileUrl})**\n⭐ **Official Creator** - Built Cordfol.io`);
    }

    if (avatar_url) {
      embed.setThumbnail(avatar_url);
    } else if (user.avatar || user.displayAvatarURL) {
      embed.setThumbnail(user.displayAvatarURL ? user.displayAvatarURL({ size: 256 }) : user.avatarURL({ size: 256 }));
    }

    if (serversRow.rowCount > 0) {
      const serverText = serversRow.rows
        .slice(0, 5)
        .map((s) => `**${s.guild_name}**`)
        .join(' • ');
      const extra = serversRow.rowCount > 5 ? ` _+${serversRow.rowCount - 5}_ ` : '';
      embed.addFields({ name: '🛡️ Verified In', value: serverText + extra, inline: false });
    }

    const socials = social_links && Array.isArray(social_links) ? social_links : [];
    if (socials.length > 0) {
      const socialEmojis = {
        twitter: '𝕏', x: '𝕏', github: '🐙', linkedin: '💼', youtube: '▶️',
        twitch: '🎮', discord: '💬', instagram: '📸', tiktok: '🎵', website: '🌐',
      };
      const socialLinks = socials
        .filter((s) => s.url)
        .map((s) => {
          const emoji = socialEmojis[s.platform?.toLowerCase()] || '🔗';
          return `[${emoji} ${s.platform}](${s.url})`;
        })
        .join(' • ');
      if (socialLinks) embed.addFields({ name: 'Follow', value: socialLinks, inline: false });
    }

    return reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    console.error('[bot] /cordfol error:', err.message);
    return reply({ content: '❌ Something went wrong while fetching your profile.', ephemeral: true });
  }
}

async function handleWhois({ target, reply, defer, ephemeral = false }) {
  await defer({ ephemeral });

  try {
    const row = await db.query(`
      SELECT u.slug, u.display_name, u.bio, u.avatar_url, u.social_links,
        json_agg(
          json_build_object('role', vr.role_name, 'guild', vr.guild_name, 'proof', vr.proof_type, 'guildId', vr.guild_id, 'guildIcon', vr.guild_icon_hash)
          ORDER BY vr.display_order
        ) FILTER (WHERE vr.is_public = true AND vr.is_active = true) as roles
      FROM users u
      LEFT JOIN verified_roles vr ON vr.user_id = u.id
      WHERE u.discord_id = $1
      GROUP BY u.slug, u.display_name, u.bio, u.avatar_url, u.social_links
    `, [target.id]);

    if (row.rowCount === 0) {
      return reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.error)
            .setTitle(`${target.username} — Not verified`)
            .setDescription('This user hasn\'t set up a Cordfol.io profile yet.'),
        ],
        ephemeral,
      });
    }

    const { slug, display_name, bio, avatar_url, social_links, roles } = row.rows[0];
    const profileUrl = buildProfileUrl(slug);

    const embed = new EmbedBuilder()
      .setColor(COLORS.discord)
      .setTitle(`${display_name}'s Verified Profile`)
      .setURL(profileUrl);

    if (target.id === EXCLUSIVE_USER_ID) {
      embed.setTitle(`${display_name}'s Verified Profile ⭐`);
    }

    if (avatar_url) {
      embed.setThumbnail(avatar_url);
    } else if (target.avatar || target.displayAvatarURL) {
      embed.setThumbnail(target.displayAvatarURL ? target.displayAvatarURL({ size: 256 }) : target.avatarURL({ size: 256 }));
    }

    if (bio) embed.setDescription(bio);

    const roleList = (roles || [])
      .slice(0, 8)
      .map((r) => `• **${r.role}** @ ${r.guild}`)
      .join('\n') || '_No public verified roles_';

    embed.addFields({ name: '🛡️ Verified Roles', value: roleList });

    const uniqueGuilds = (roles || []).reduce((acc, r) => {
      if (!acc.find((g) => g.guildId === r.guildId)) acc.push(r);
      return acc;
    }, []);

    if (uniqueGuilds.length > 0) {
      const guildNames = uniqueGuilds.slice(0, 5).map((g) => `**${g.guild}**`).join(' • ');
      const extra = uniqueGuilds.length > 5 ? ` _+${uniqueGuilds.length - 5} more_` : '';
      embed.addFields({ name: '🏆 Verified Servers', value: guildNames + extra, inline: false });
    }

    const socials = social_links && Array.isArray(social_links) ? social_links : [];
    if (socials.length > 0) {
      const socialEmojis = {
        twitter: '𝕏', x: '𝕏', github: '🐙', linkedin: '💼', youtube: '▶️',
        twitch: '🎮', discord: '💬', instagram: '📸', tiktok: '🎵', website: '🌐',
      };
      const socialLinks = socials
        .filter((s) => s.url)
        .map((s) => {
          const emoji = socialEmojis[s.platform?.toLowerCase()] || '🔗';
          return `[${emoji} ${s.platform}](${s.url})`;
        })
        .join(' • ');
      if (socialLinks) embed.addFields({ name: 'Follow', value: socialLinks, inline: false });
    }

    embed.setFooter({ text: `${PUBLIC_HOST}/${slug} · Verified by Discord API` });
    return reply({ embeds: [embed], ephemeral });
  } catch (err) {
    console.error('[bot] /whois error:', err.message);
    return reply({ content: '❌ Something went wrong while looking up that user.', ephemeral });
  }
}

async function handleStatusView({ reply }) {
  const status = statusStore.readStatus();
  return reply({ embeds: [statusEmbed(status)], ephemeral: false });
}

async function handleStatusSet({ state, message, user, reply }) {
  const defaults = {
    up: 'All systems operational.',
    degraded: 'Some features may be slow or unavailable.',
    down: 'Cordfol is currently down. We are investigating.',
    maintenance: 'Scheduled maintenance is in progress.',
  };
  const { status, results } = await setAndBroadcastStatus({
    state,
    message: message || defaults[state],
    user,
    alsoAnnounce: state !== 'up',
  });

  const posted = results.filter((r) => r.ok).length;
  const channelHint = (!STATUS_CHANNEL_ID && !ANNOUNCE_CHANNEL_ID)
    ? ' (no STATUS_CHANNEL_ID / ANNOUNCE_CHANNEL_ID configured — saved locally only)'
    : posted
      ? ` Posted to ${posted} channel(s).`
      : ' (channel post failed — check bot permissions / channel IDs)';

  return reply({
    content: `✅ Status set to **${state}**.${channelHint}`,
    embeds: [statusEmbed(status)],
    ephemeral: true,
  });
}

async function handleAnnounce({ title, message, user, reply }) {
  const embed = announceEmbed({
    title: title || '📢 Cordfol Announcement',
    description: message,
    color: COLORS.brand,
  });
  embed.addFields({ name: 'From', value: user.username || user.tag || String(user.id), inline: true });

  const targetId = ANNOUNCE_CHANNEL_ID || STATUS_CHANNEL_ID;
  if (!targetId) {
    return reply({
      content: '❌ Set `ANNOUNCE_CHANNEL_ID` (or `STATUS_CHANNEL_ID`) in the environment.',
      ephemeral: true,
    });
  }

  const result = await sendToChannel(targetId, { embeds: [embed] });
  if (!result.ok) {
    return reply({ content: `❌ Failed to announce: ${result.error}`, ephemeral: true });
  }
  return reply({ content: `✅ Announced in <#${targetId}>.`, ephemeral: true });
}

async function handleBroadcast({ message, user, reply }) {
  if (!STATUS_CHANNEL_ID) {
    return reply({ content: '❌ Set `STATUS_CHANNEL_ID` in the environment.', ephemeral: true });
  }
  const embed = announceEmbed({
    title: '📡 Cordfol Broadcast',
    description: message,
    color: COLORS.discord,
  });
  embed.addFields({ name: 'From', value: user.username || user.tag || String(user.id), inline: true });
  const result = await sendToChannel(STATUS_CHANNEL_ID, { embeds: [embed] });
  if (!result.ok) {
    return reply({ content: `❌ Failed to broadcast: ${result.error}`, ephemeral: true });
  }
  return reply({ content: `✅ Broadcast to <#${STATUS_CHANNEL_ID}>.`, ephemeral: true });
}

// ── Interaction reply adapters ────────────────────────────────────────────────

function interactionAdapter(interaction) {
  let deferred = false;
  return {
    async defer({ ephemeral } = {}) {
      if (deferred || interaction.deferred || interaction.replied) {
        deferred = true;
        return;
      }
      await interaction.deferReply({ ephemeral: !!ephemeral });
      deferred = true;
    },
    async reply(payload) {
      const { ephemeral, ...rest } = payload;
      if (deferred || interaction.deferred) {
        deferred = true;
        return interaction.editReply(rest);
      }
      if (interaction.replied) {
        return interaction.followUp({ ...rest, ephemeral: !!ephemeral });
      }
      return interaction.reply({ ...rest, ephemeral: !!ephemeral });
    },
  };
}

function messageAdapter(message) {
  return {
    async defer() {},
    async reply(payload) {
      const { embeds, content } = payload;
      return message.reply({ content: content || undefined, embeds: embeds || undefined });
    },
  };
}

// ── Ready / registration ──────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  console.log(`[bot] In ${client.guilds.cache.size} servers`);
  console.log(`[bot] Prefix: ${BOT_PREFIX} | Cordfol guild: ${CORDFOL_GUILD_ID}`);
  await registerCommands();

  if (global.setBotClient) {
    global.setBotClient(client);
  }
});

// ── Slash interactions ────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  const adapter = interactionAdapter(interaction);

  try {
    if (commandName === 'verify') {
      return handleVerify({
        user,
        guildId: interaction.guildId,
        guild: interaction.guild,
        ...adapter,
      });
    }

    if (commandName === 'cordfol') {
      return handleCordfol({ user, ...adapter });
    }

    if (commandName === 'whois') {
      const target = interaction.options.getUser('user');
      return handleWhois({ target, ...adapter });
    }

    if (commandName === 'help') {
      return adapter.reply({ embeds: [helpEmbed()], ephemeral: true });
    }

    // Guild-only ops commands — defer immediately (Discord 3s ACK window)
    if (['status', 'announce', 'maintenance', 'outage', 'broadcast'].includes(commandName)) {
      const isStatusView =
        commandName === 'status' && interaction.options.getSubcommand(false) === 'view';

      await adapter.defer({ ephemeral: !isStatusView });

      if (isStatusView) {
        if (!isCordfolGuild(interaction.guildId)) {
          return adapter.reply({ content: '❌ This command is only available in the Cordfol server.' });
        }
        return handleStatusView(adapter);
      }

      const gate = await assertOps(interaction);
      if (!gate.ok) return adapter.reply({ content: gate.reply });

      if (commandName === 'status') {
        const state = interaction.options.getString('state');
        const message = interaction.options.getString('message');
        if (!state) {
          return adapter.reply({ content: '❌ Missing status state. Use `/status set` with a state.' });
        }
        return handleStatusSet({ state, message, user, ...adapter });
      }

      if (commandName === 'announce') {
        return handleAnnounce({
          title: interaction.options.getString('title'),
          message: interaction.options.getString('message'),
          user,
          ...adapter,
        });
      }

      if (commandName === 'maintenance') {
        return handleStatusSet({
          state: 'maintenance',
          message: interaction.options.getString('message') || 'Scheduled maintenance is in progress.',
          user,
          ...adapter,
        });
      }

      if (commandName === 'outage') {
        return handleStatusSet({
          state: 'down',
          message: interaction.options.getString('message') || 'Cordfol is currently down. We are investigating.',
          user,
          ...adapter,
        });
      }

      if (commandName === 'broadcast') {
        return handleBroadcast({
          message: interaction.options.getString('message'),
          user,
          ...adapter,
        });
      }
    }
  } catch (err) {
    console.error(`[bot] interaction ${commandName} error:`, err);
    try {
      await adapter.reply({ content: '❌ Something went wrong.' });
    } catch { /* ignore */ }
  }
});

// ── Prefix commands ───────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(BOT_PREFIX)) return;

  const body = message.content.slice(BOT_PREFIX.length).trim();
  if (!body) return;

  const [rawCmd, ...rest] = body.split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const argsText = body.slice(rawCmd.length).trim();
  const adapter = messageAdapter(message);
  const user = message.author;

  try {
    if (cmd === 'help' || cmd === 'commands') {
      return adapter.reply({ embeds: [helpEmbed()] });
    }

    if (cmd === 'ping') {
      const latency = Date.now() - message.createdTimestamp;
      return adapter.reply({ content: `🏓 Pong · \`${latency}ms\` ws \`${Math.round(client.ws.ping)}ms\`` });
    }

    if (cmd === 'verify') {
      return handleVerify({
        user,
        guildId: message.guild.id,
        guild: message.guild,
        ...adapter,
      });
    }

    if (cmd === 'cordfol' || cmd === 'profile') {
      return handleCordfol({ user, ...adapter });
    }

    if (cmd === 'whois') {
      const target = message.mentions.users.first();
      if (!target) {
        return adapter.reply({ content: `Usage: \`${BOT_PREFIX}whois @user\`` });
      }
      return handleWhois({ target, ...adapter });
    }

    if (['status', 'announce', 'maintenance', 'outage', 'broadcast'].includes(cmd)) {
      if (cmd === 'status' && (!rest[0] || !statusStore.VALID_STATES.has(rest[0].toLowerCase()))) {
        if (!isCordfolGuild(message.guild.id)) {
          return adapter.reply({ content: '❌ Status commands are only available in the Cordfol server.' });
        }
        return handleStatusView(adapter);
      }

      const gate = await assertOps(message);
      if (!gate.ok) return adapter.reply({ content: gate.reply });

      if (cmd === 'status') {
        const state = rest[0].toLowerCase();
        const messageText = rest.slice(1).join(' ').trim();
        return handleStatusSet({ state, message: messageText || undefined, user, ...adapter });
      }

      if (cmd === 'announce') {
        if (!argsText) return adapter.reply({ content: `Usage: \`${BOT_PREFIX}announce <message>\`` });
        return handleAnnounce({ message: argsText, user, ...adapter });
      }

      if (cmd === 'maintenance') {
        return handleStatusSet({
          state: 'maintenance',
          message: argsText || 'Scheduled maintenance is in progress.',
          user,
          ...adapter,
        });
      }

      if (cmd === 'outage') {
        return handleStatusSet({
          state: 'down',
          message: argsText || 'Cordfol is currently down. We are investigating.',
          user,
          ...adapter,
        });
      }

      if (cmd === 'broadcast') {
        if (!argsText) return adapter.reply({ content: `Usage: \`${BOT_PREFIX}broadcast <message>\`` });
        return handleBroadcast({ message: argsText, user, ...adapter });
      }
    }
  } catch (err) {
    console.error(`[bot] prefix ${cmd} error:`, err.message);
    try {
      await adapter.reply({ content: '❌ Something went wrong.' });
    } catch { /* ignore */ }
  }
});

// ── Community: welcome (Cordfol guild) ────────────────────────────────────────

client.on('guildMemberAdd', async (member) => {
  try {
    if (!isCordfolGuild(member.guild.id)) return;
    const channelId = WELCOME_CHANNEL_ID || ANNOUNCE_CHANNEL_ID;
    if (!channelId) return;

    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle('Welcome to Cordfol')
      .setDescription(
        `Hey ${member}, welcome!\n\n` +
        `• Create your verified profile at **[${PUBLIC_HOST}](${DASHBOARD_LOGIN_URL})**\n` +
        `• Use \`/verify\` or \`${BOT_PREFIX}verify\` to sync your roles\n` +
        `• \`${BOT_PREFIX}help\` for commands`
      )
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .setFooter({ text: `${PUBLIC_HOST} — Discord Identity, Verified.` })
      .setTimestamp();

    await sendToChannel(channelId, { embeds: [embed] });
  } catch (err) {
    console.error('[bot] guildMemberAdd welcome error:', err.message);
  }
});

// ── Presence Tracking ─────────────────────────────────────────────────────────
const presenceDebounce = new Map();

function describeActivity(presence) {
  const activities = presence?.activities || [];
  const act = activities.find((a) => a.type !== 4) || null;
  if (!act) {
    const custom = activities.find((a) => a.type === 4 && a.state);
    return custom ? custom.state.slice(0, 120) : null;
  }
  const prefixes = { 0: 'Playing', 1: 'Streaming', 2: 'Listening to', 3: 'Watching', 5: 'Competing in' };
  const prefix = prefixes[act.type] || '';
  return `${prefix} ${act.name}`.trim().slice(0, 120);
}

client.on('presenceUpdate', async (_oldPresence, newPresence) => {
  try {
    const discordId = newPresence?.userId || newPresence?.user?.id;
    if (!discordId) return;

    const last = presenceDebounce.get(discordId) || 0;
    if (Date.now() - last < 15000) return;
    presenceDebounce.set(discordId, Date.now());
    if (presenceDebounce.size > 5000) presenceDebounce.clear();

    const status = newPresence.status || 'offline';
    const activity = describeActivity(newPresence);

    await db.query(`
      UPDATE users SET
        presence_status = $1,
        presence_activity = $2,
        presence_updated_at = NOW()
      WHERE discord_id = $3
    `, [status, activity, discordId]);
  } catch (err) {
    console.error('[bot] presenceUpdate error:', err.message);
  }
});

// ── Guild Member Remove ───────────────────────────────────────────────────────
client.on('guildMemberRemove', async (member) => {
  try {
    const userRow = await db.query(
      'SELECT id FROM users WHERE discord_id = $1',
      [member.user.id]
    );
    if (userRow.rowCount === 0) return;

    await db.query(`
      UPDATE verified_roles
      SET is_active = false, last_checked_at = NOW()
      WHERE user_id = $1 AND guild_id = $2
    `, [userRow.rows[0].id, member.guild.id]);

    console.log(`[bot] Marked roles inactive: ${member.user.tag} left ${member.guild.name}`);
  } catch (err) {
    console.error('[bot] guildMemberRemove error:', err);
  }
});

// ── Guild Member Role Update ──────────────────────────────────────────────────
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const userRow = await db.query(
      'SELECT id FROM users WHERE discord_id = $1',
      [newMember.user.id]
    );
    if (userRow.rowCount === 0) return;

    const addedRoles = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id) && r.id !== newMember.guild.id);
    const removedRoles = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id) && r.id !== newMember.guild.id);
    const userId = userRow.rows[0].id;
    const guildId = newMember.guild.id;

    for (const [, role] of addedRoles) {
      await db.query(`
        INSERT INTO verified_roles
          (id, user_id, guild_id, guild_name, guild_icon_hash, role_id, role_name, role_color,
           verified_at, last_checked_at, is_active, proof_type, is_public, display_order)
        VALUES
          (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), true, 'BOT', true, 0)
        ON CONFLICT (user_id, guild_id, role_id)
        DO UPDATE SET is_active = true, last_checked_at = NOW(), role_name = EXCLUDED.role_name
      `, [userId, guildId, newMember.guild.name, newMember.guild.icon, role.id, role.name, role.color || 0]);
    }

    for (const [, role] of removedRoles) {
      await db.query(`
        UPDATE verified_roles SET is_active = false, last_checked_at = NOW()
        WHERE user_id = $1 AND guild_id = $2 AND role_id = $3
      `, [userId, guildId, role.id]);
    }
  } catch (err) {
    console.error('[bot] guildMemberUpdate error:', err);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
client.login(BOT_TOKEN);

module.exports = client;
