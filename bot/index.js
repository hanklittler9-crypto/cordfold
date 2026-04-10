// ─────────────────────────────────────────────────────────────────────────────
// Cordfol.io — Server Bot (bot/index.js)
// Role: Sits inside Discord servers. When a user logs in via dashboard OAuth,
//       this bot confirms their role membership server-side (bot-level proof).
//
// Separate from the OAuth user token — this bot uses its own Bot Token which
// has higher rate limits (1000 req/10s vs 50/s for user OAuth tokens).
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const { Pool } = require('pg');

// ── Environment ───────────────────────────────────────────────────────────────
const {
  BOT_TOKEN,          // Discord bot token (from Discord Developer Portal)
  BOT_CLIENT_ID,      // Your bot's application/client ID
  DATABASE_URL,       // Neon PostgreSQL connection string
  DASHBOARD_URL,      // e.g. https://cordfol.io/dashboard
} = process.env;

const DASHBOARD_LOGIN_URL = DASHBOARD_URL || 'https://dashboard.cordfol.org/dashboard';
const PUBLIC_BASE_URL = (() => {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }

  try {
    const dashboardUrl = new URL(DASHBOARD_LOGIN_URL);
    return `${dashboardUrl.protocol}//${dashboardUrl.host.replace(/^dashboard\./, '')}`;
  } catch {
    return 'https://cordfol.io';
  }
})();
const PUBLIC_HOST = (() => {
  try {
    return new URL(PUBLIC_BASE_URL).host;
  } catch {
    return 'cordfol.io';
  }
})();

function buildProfileUrl(slug) {
  return `${PUBLIC_BASE_URL}/${slug}`;
}

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// ── Discord Client ────────────────────────────────────────────────────────────
// IMPORTANT: We only need GuildMembers intent to read role data.
// We do NOT need MessageContent or Presence — keeps the bot minimal and
// avoids requiring privileged intent approval for basic use.
const client = new Client({
  intents: [
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Slash Commands ─────────────────────────────────────────────────────────────
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

// ── Register Commands (run once on startup) ───────────────────────────────────
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

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  console.log(`[bot] In ${client.guilds.cache.size} servers`);
  await registerCommands();
});

// ── Interaction Handler ───────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, user } = interaction;

  // ── /verify ────────────────────────────────────────────────────────────────
  if (commandName === 'verify') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      // Ignore if already deferred or replied
      if (interaction.deferred || interaction.replied) return;
      console.error('[bot] Failed to defer reply:', err);
      return;
    }
    try {
      // 1. Check if this Discord user has a Cordfol account
      const userRow = await db.query(
        'SELECT id, slug, display_name FROM users WHERE discord_id = $1',
        [user.id]
      );

      if (userRow.rowCount === 0) {
        if (!interaction.replied && !interaction.deferred) return;
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle('You don\'t have a Cordfol.io account yet')
              .setDescription(
                `Log in with Discord at **[${PUBLIC_HOST}](${DASHBOARD_LOGIN_URL})** to create your verified profile.\n\nOnce you log in, your roles in **${guild.name}** will be verified automatically.`
              )
              .setFooter({ text: `${PUBLIC_HOST} — Discord Identity, Verified.` })
          ]
        });
      }

      const cordfolUser = userRow.rows[0];

      // 2. Fetch the member's roles in THIS guild using the bot token
      //    This is the "bot proof" — higher trust than OAuth alone
      const member = await guild.members.fetch(user.id);
      if (!member) {
        if (!interaction.replied && !interaction.deferred) return;
        return interaction.editReply({ content: '❌ Could not find you in this server.' });
      }

      // 3. Get all roles (excluding @everyone)
      const roles = member.roles.cache
        .filter(r => r.id !== guild.id)
        .map(r => ({ id: r.id, name: r.name, color: r.color }));

      if (roles.length === 0) {
        if (!interaction.replied && !interaction.deferred) return;
        return interaction.editReply({ content: '⚠️ You don\'t have any roles in this server to verify.' });
      }

      // 4. Upsert each role into verified_roles with proof_type = 'BOT'
      for (const role of roles) {
        await db.query(`
          INSERT INTO verified_roles
            (id, user_id, guild_id, guild_name, guild_icon_hash, role_id, role_name, role_color,
             verified_at, last_checked_at, is_active, proof_type, is_public, display_order)
          VALUES
            (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7,
             NOW(), NOW(), true, 'BOT', true, 0)
          ON CONFLICT (user_id, guild_id, role_id)
          DO UPDATE SET
            role_name = EXCLUDED.role_name,
            role_color = EXCLUDED.role_color,
            is_active = true,
            last_checked_at = NOW(),
            proof_type = 'BOT'
        `, [
          cordfolUser.id,
          guild.id,
          guild.name,
          guild.icon,
          role.id,
          role.name,
          role.color,
        ]);
      }

      // 5. Reply with success
      const roleList = roles.slice(0, 5).map(r => `• **${r.name}**`).join('\n');
      const extra = roles.length > 5 ? `\n_...and ${roles.length - 5} more_` : '';

      if (!interaction.replied && !interaction.deferred) return;
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00FFB2)
            .setTitle('✅ Roles verified with bot-level proof!')
            .setDescription(
              `Your roles in **${guild.name}** have been added to your Cordfol.io profile:\n\n${roleList}${extra}\n\n🔗 [View your profile](${buildProfileUrl(cordfolUser.slug)})`
            )
            .setFooter({ text: `${PUBLIC_HOST} — These roles cannot be faked.` })
        ]
      });

    } catch (err) {
      console.error('[bot] /verify error:', err.message);
      console.error('[bot] Full error:', err);
      if (!interaction.replied && !interaction.deferred) return;
      return interaction.editReply({ content: `❌ Error: ${err.message}` });
    }
  }

  // ── /cordfol ───────────────────────────────────────────────────────────────
  if (commandName === 'cordfol') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const row = await db.query(
        'SELECT slug, display_name FROM users WHERE discord_id = $1',
        [user.id]
      );

      if (row.rowCount === 0) {
        return interaction.editReply({
          content: `You don't have a Cordfol.io profile yet. Sign up at ${DASHBOARD_LOGIN_URL}`
        });
      }

      const { slug, display_name } = row.rows[0];
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`${display_name}'s Cordfol.io Profile`)
            .setURL(buildProfileUrl(slug))
            .setDescription(`🔗 ${PUBLIC_HOST}/${slug}`)
        ]
      });
    } catch (err) {
      console.error('[bot] /cordfol error:', err);
      return interaction.editReply({ content: '❌ Something went wrong.' });
    }
  }

  // ── /whois ─────────────────────────────────────────────────────────────────
  if (commandName === 'whois') {
    await interaction.deferReply();

    const target = interaction.options.getUser('user');

    try {
      const row = await db.query(`
        SELECT u.slug, u.display_name, u.bio,
          json_agg(
            json_build_object('role', vr.role_name, 'guild', vr.guild_name, 'proof', vr.proof_type)
            ORDER BY vr.display_order
          ) FILTER (WHERE vr.is_public = true AND vr.is_active = true) as roles
        FROM users u
        LEFT JOIN verified_roles vr ON vr.user_id = u.id
        WHERE u.discord_id = $1
        GROUP BY u.slug, u.display_name, u.bio
      `, [target.id]);

      if (row.rowCount === 0) {
        return interaction.editReply({ content: `**${target.username}** doesn't have a Cordfol.io profile yet.` });
      }

      const { slug, display_name, bio, roles } = row.rows[0];
      const roleList = (roles || [])
        .slice(0, 5)
        .map(r => `• **${r.role}** @ ${r.guild} _(${r.proof})_`)
        .join('\n') || '_No verified roles yet_';

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`${display_name}'s Verified Profile`)
            .setURL(buildProfileUrl(slug))
            .setDescription(bio || '')
            .addFields({ name: '🛡️ Verified Roles', value: roleList })
            .setFooter({ text: `${PUBLIC_HOST}/${slug} · Verified by Discord API` })
        ]
      });

    } catch (err) {
      console.error('[bot] /whois error:', err);
      return interaction.editReply({ content: '❌ Something went wrong.' });
    }
  }
});

// ── Guild Member Remove — mark roles inactive instantly ──────────────────────
// Instead of waiting 24h for the background re-check, we listen for the
// GUILD_MEMBER_REMOVE event and immediately flip is_active = false for
// all roles in that guild for that user.
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

// ── Guild Member Role Update — update roles in real-time ─────────────────────
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const userRow = await db.query(
      'SELECT id FROM users WHERE discord_id = $1',
      [newMember.user.id]
    );
    if (userRow.rowCount === 0) return; // Not a Cordfol user

    const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id) && r.id !== newMember.guild.id);
    const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id) && r.id !== newMember.guild.id);
    const userId = userRow.rows[0].id;
    const guildId = newMember.guild.id;

    // Add new roles
    for (const [, role] of addedRoles) {
      await db.query(`
        INSERT INTO verified_roles
          (id, user_id, guild_id, guild_name, guild_icon_hash, role_id, role_name, role_color,
           verified_at, last_checked_at, is_active, proof_type, is_public, display_order)
        VALUES
          (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), true, 'BOT', true, 0)
        ON CONFLICT (user_id, guild_id, role_id)
        DO UPDATE SET is_active = true, last_checked_at = NOW(), role_name = EXCLUDED.role_name
      `, [userId, guildId, newMember.guild.name, newMember.guild.icon, role.id, role.name, role.color]);
    }

    // Mark removed roles as inactive
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
