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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

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
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  // ── /verify ────────────────────────────────────────────────────────────────
  if (commandName === 'verify') {
    if (!interaction.guildId) {
      return interaction.reply({ content: '❌ This command can only be used inside a server.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
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
      const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
      const member = await guild.members.fetch(user.id);

      if (!member) {
        return interaction.editReply({ content: '❌ Could not find you in this server.' });
      }

      const roles = member.roles.cache
        .filter(r => !r.managed && r.id !== guild.id)
        .map(r => ({ id: r.id, name: r.name, color: r.color || 0 }));

      if (roles.length === 0) {
        return interaction.editReply({ content: '⚠️ You don\'t have any roles in this server to verify.' });
      }

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

      const roleList = roles.slice(0, 5).map(r => `• **${r.name}**`).join('\n');
      const extra = roles.length > 5 ? `\n_...and ${roles.length - 5} more_` : '';

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
      console.error('[bot] /verify error:', err);
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