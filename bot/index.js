// ─────────────────────────────────────────────────────────────────────────────
// Cordfol.io — Server Bot (bot/index.js)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const { Pool } = require('pg');

const {
  BOT_TOKEN,
  BOT_CLIENT_ID,
  DATABASE_URL,
  DASHBOARD_URL,
} = process.env;

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

// Exclusive user ID for special features
const EXCLUSIVE_USER_ID = '1127435524022472805';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
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

const commands = [
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
    .addUserOption(opt =>
      opt.setName('user').setDescription('The Discord user to look up').setRequired(true)
    )
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log('[bot] Registering slash commands...');
    await rest.put(Routes.applicationCommands(BOT_CLIENT_ID), { body: commands });
    console.log('[bot] Slash commands registered globally.');
  } catch (err) {
    console.error('[bot] Failed to register commands:', err);
  }
}

client.once('ready', async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  console.log(`[bot] In ${client.guilds.cache.size} servers`);
  await registerCommands();
  
  // Register with server
  if (global.setBotClient) {
    global.setBotClient(client);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  // ── /verify ────────────────────────────────────────────────────────────────
  if (commandName === 'verify') {
    if (!interaction.guildId) {
      return interaction.reply({ content: '❌ This command can only be used inside a server.', ephemeral: true });
    }

    // Check cooldown
    const cooldownSeconds = checkCooldown(user.id, interaction.guildId);
    if (cooldownSeconds) {
      return interaction.reply({
        content: `⏳ You're verifying too quickly! Please wait **${cooldownSeconds}s** before verifying again.`,
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Check if user has Cordfol account
      const userRow = await db.query(
        'SELECT id, slug, display_name FROM users WHERE discord_id = $1',
        [user.id]
      );

      if (userRow.rowCount === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle('You don\'t have a Cordfol.io account yet')
              .setDescription(`Log in at **[${PUBLIC_HOST}](${DASHBOARD_LOGIN_URL})** to create your verified profile.`)
              .setFooter({ text: `${PUBLIC_HOST} — Discord Identity, Verified.` })
          ]
        });
      }

      const cordfolUser = userRow.rows[0];
      
      // Fetch guild and member
      let guild;
      try {
        guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
      } catch (err) {
        console.error('[bot] Failed to fetch guild:', err);
        return interaction.editReply({ content: '❌ I couldn\'t connect to this server. Please try again.' });
      }

      let member;
      try {
        member = await guild.members.fetch(user.id);
      } catch (err) {
        console.error('[bot] Failed to fetch member:', err);
        return interaction.editReply({
          content: '❌ I couldn\'t find you in this server. Make sure you\'re a member and the bot has permission to access members.'
        });
      }

      // Get roles
      const roles = member.roles.cache
        .filter(r => !r.managed && r.id !== guild.id)
        .map(r => ({ id: r.id, name: r.name, color: r.color || 0 }));

      if (roles.length === 0) {
        return interaction.editReply({
          content: '⚠️ You don\'t have any assignable roles in this server. Only manual roles (not bot roles) can be verified.'
        });
      }

      // Batch insert roles (much faster)
      const values = roles.map((role, idx) => 
        `(gen_random_uuid(), $1, $2, $3, $4, $${5 + (idx * 3)}, $${6 + (idx * 3)}, $${7 + (idx * 3)})`
      ).join(',');

      const params = [cordfolUser.id, guild.id, guild.name, guild.icon];
      roles.forEach(role => {
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

      const roleList = roles.slice(0, 5).map(r => `• **${r.name}**`).join('\n');
      const extra = roles.length > 5 ? `\n_...and ${roles.length - 5} more_` : '';

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00FFB2)
            .setTitle('✅ Roles verified with bot-level proof!')
            .setDescription(
              `Your **${roles.length}** role${roles.length !== 1 ? 's' : ''} in **${guild.name}** have been added to your Cordfol.io profile:\n\n${roleList}${extra}\n\n🔗 [View your profile](${buildProfileUrl(cordfolUser.slug)})`
            )
            .setFooter({ text: `${PUBLIC_HOST} — These roles cannot be faked.` })
        ]
      });

    } catch (err) {
      console.error('[bot] /verify error:', err.message);
      return interaction.editReply({
        content: '❌ Something went wrong while verifying your roles. Please try again later or contact support.'
      });
    }
  }

  // ── /cordfol ───────────────────────────────────────────────────────────────
  if (commandName === 'cordfol') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const row = await db.query(
        'SELECT slug, display_name, avatar_url, social_links FROM users WHERE discord_id = $1',
        [user.id]
      );

      if (row.rowCount === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xFF6B6B)
              .setTitle('No Cordfol.io account found')
              .setDescription(`Create one at **[${PUBLIC_HOST}](${DASHBOARD_LOGIN_URL})**`)
              .setFooter({ text: 'Link your Discord account during signup' })
          ]
        });
      }

      const { slug, display_name, avatar_url, social_links } = row.rows[0];
      const profileUrl = buildProfileUrl(slug);

      // Fetch verified servers/roles
      const serversRow = await db.query(
        'SELECT DISTINCT guild_name, guild_id, guild_icon_hash FROM verified_roles WHERE user_id = (SELECT id FROM users WHERE discord_id = $1) AND is_active = true',
        [user.id]
      );
      
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${display_name}'s Cordfol.io Profile`)
        .setURL(profileUrl)
        .setDescription(`🔗 **[${PUBLIC_HOST}/${slug}](${profileUrl})**`);

      // Add exclusive badge for special user
      if (user.id === EXCLUSIVE_USER_ID) {
        embed.setDescription(`🔗 **[${PUBLIC_HOST}/${slug}](${profileUrl})**\n⭐ **Official Creator** - Built Cordfol.io`);
      }

      // Add avatar if available
      if (avatar_url) {
        embed.setThumbnail(avatar_url);
      } else if (user.avatar) {
        embed.setThumbnail(user.avatarURL({ size: 256 }));
      }

      // Add verified servers as badges
      if (serversRow.rowCount > 0) {
        const serverBadges = serversRow.rows
          .slice(0, 8)
          .map(s => {
            const icon = s.guild_icon_hash 
              ? `https://cdn.discordapp.com/icons/${s.guild_id}/${s.guild_icon_hash}.png`
              : '🏠';
            return `[${icon === '🏠' ? '🏠' : ''}](${icon === '🏠' ? '#' : icon})`;
          })
          .join('');

        const serverText = serversRow.rows
          .slice(0, 5)
          .map(s => `**${s.guild_name}**`)
          .join(' • ');

        const extra = serversRow.rowCount > 5 ? ` _+${serversRow.rowCount - 5}_ ` : '';

        embed.addFields({ 
          name: '🛡️ Verified In', 
          value: serverText + extra, 
          inline: false 
        });
      }

      // Add social links if they exist
      const socials = social_links && Array.isArray(social_links) ? social_links : [];
      if (socials.length > 0) {
        const socialEmojis = {
          'twitter': '𝕏',
          'x': '𝕏',
          'github': '🐙',
          'linkedin': '💼',
          'youtube': '▶️',
          'twitch': '🎮',
          'discord': '💬',
          'instagram': '📸',
          'tiktok': '🎵',
          'website': '🌐',
        };

        const socialLinks = socials
          .filter(s => s.url)
          .map(s => {
            const emoji = socialEmojis[s.platform?.toLowerCase()] || '🔗';
            return `[${emoji} ${s.platform}](${s.url})`;
          })
          .join(' • ');

        if (socialLinks) {
          embed.addFields({ name: 'Follow', value: socialLinks, inline: false });
        }
      }

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[bot] /cordfol error:', err.message);
      return interaction.editReply({
        content: '❌ Something went wrong while fetching your profile.'
      });
    }
  }

  // ── /whois ─────────────────────────────────────────────────────────────────
  if (commandName === 'whois') {
    await interaction.deferReply();

    const target = interaction.options.getUser('user');

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
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xFF6B6B)
              .setTitle(`${target.username} — Not verified`)
              .setDescription('This user hasn\'t set up a Cordfol.io profile yet.')
          ]
        });
      }

      const { slug, display_name, bio, avatar_url, social_links, roles } = row.rows[0];
      const profileUrl = buildProfileUrl(slug);
      
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${display_name}'s Verified Profile`)
        .setURL(profileUrl);

      // Add exclusive badge for special user
      if (target.id === EXCLUSIVE_USER_ID) {
        embed.setTitle(`${display_name}'s Verified Profile ⭐`);
      }

      // Add avatar
      if (avatar_url) {
        embed.setThumbnail(avatar_url);
      } else if (target.avatar) {
        embed.setThumbnail(target.avatarURL({ size: 256 }));
      }

      // Add bio if it exists
      if (bio) {
        embed.setDescription(bio);
      }

      // Add verified roles with guild context
      const roleList = (roles || [])
        .slice(0, 8)
        .map(r => `• **${r.role}** @ ${r.guild}`)
        .join('\n') || '_No public verified roles_';

      embed.addFields({ name: '🛡️ Verified Roles', value: roleList });

      // Add unique verified servers/guilds summary
      const uniqueGuilds = (roles || [])
        .reduce((acc, r) => {
          if (!acc.find(g => g.guildId === r.guildId)) {
            acc.push(r);
          }
          return acc;
        }, []);

      if (uniqueGuilds.length > 0) {
        const guildNames = uniqueGuilds
          .slice(0, 5)
          .map(g => `**${g.guild}**`)
          .join(' • ');
        
        const extra = uniqueGuilds.length > 5 ? ` _+${uniqueGuilds.length - 5} more_` : '';
        
        embed.addFields({ 
          name: '🏆 Verified Servers', 
          value: guildNames + extra, 
          inline: false 
        });
      }

      // Add social links if they exist
      const socials = social_links && Array.isArray(social_links) ? social_links : [];
      if (socials.length > 0) {
        const socialEmojis = {
          'twitter': '𝕏',
          'x': '𝕏',
          'github': '🐙',
          'linkedin': '💼',
          'youtube': '▶️',
          'twitch': '🎮',
          'discord': '💬',
          'instagram': '📸',
          'tiktok': '🎵',
          'website': '🌐',
        };

        const socialLinks = socials
          .filter(s => s.url)
          .map(s => {
            const emoji = socialEmojis[s.platform?.toLowerCase()] || '🔗';
            return `[${emoji} ${s.platform}](${s.url})`;
          })
          .join(' • ');

        if (socialLinks) {
          embed.addFields({ name: 'Follow', value: socialLinks, inline: false });
        }
      }

      embed.setFooter({ text: `${PUBLIC_HOST}/${slug} · Verified by Discord API` });

      return interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('[bot] /whois error:', err.message);
      return interaction.editReply({
        content: '❌ Something went wrong while looking up that user.'
      });
    }
  }
});

// ── Presence Tracking ─────────────────────────────────────────────────────────
// Stores last known status + activity for registered users so their public
// profile can show a live Discord presence dot. Requires the "Presence Intent"
// toggle in the Discord Developer Portal → Bot settings.
const presenceDebounce = new Map(); // discordId -> last write ms

function describeActivity(presence) {
  const activities = presence?.activities || [];
  const act = activities.find(a => a.type !== 4) || null; // skip custom status
  if (!act) {
    const custom = activities.find(a => a.type === 4 && a.state);
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

    // Debounce per user (presence events can fire rapidly)
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

    const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id) && r.id !== newMember.guild.id);
    const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id) && r.id !== newMember.guild.id);
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