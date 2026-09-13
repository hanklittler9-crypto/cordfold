const path = require('path');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const { readJson, writeJson } = require('./json-store');
const { syncVerifiedRoles } = require('./verify-sync');
const { isProPlan } = require('../pro');

const STORE = path.join(__dirname, 'data', 'onboarding.json');
const OPEN_BTN = 'cf_roles_open';
const SELECT_PREFIX = 'cf_roles:';
const ROLES_PAGE_URL = (process.env.PUBLIC_BASE_URL || 'https://cordfol.org').replace(/\/$/, '') + '/roles';

const ROLE_GROUPS = [
  {
    id: 'pronouns',
    title: 'Pronouns',
    placeholder: 'How should people refer to you?',
    exclusive: true,
    color: 0x9aa0a6,
    roles: [
      { key: 'he', name: 'He / Him' },
      { key: 'she', name: 'She / Her' },
      { key: 'they', name: 'They / Them' },
      { key: 'ask', name: 'Ask my pronouns' },
    ],
  },
  {
    id: 'iam',
    title: 'I am',
    placeholder: 'What describes you here?',
    exclusive: false,
    color: 0xc46bff,
    roles: [
      { key: 'creator', name: 'Creator' },
      { key: 'developer', name: 'Developer' },
      { key: 'designer', name: 'Designer' },
      { key: 'collector', name: 'Collector' },
      { key: 'browsing', name: 'Just browsing' },
    ],
  },
  {
    id: 'focus',
    title: 'I care about',
    placeholder: 'What are you here for?',
    exclusive: false,
    color: 0x5865F2,
    roles: [
      { key: 'profiles', name: 'Profiles' },
      { key: 'bots', name: 'Bots' },
      { key: 'ai', name: 'AI' },
      { key: 'ops', name: 'Discord ops' },
    ],
  },
  {
    id: 'pings',
    title: 'Pings',
    placeholder: 'What should we ping you for?',
    exclusive: false,
    color: 0x3dd68c,
    roles: [
      { key: 'announce', name: 'Announcements' },
      { key: 'status', name: 'Status alerts' },
      { key: 'drops', name: 'Drops' },
    ],
  },
];

function loadStore() {
  return readJson(STORE, () => ({
    proRoleId: '',
    rolesChannelId: '',
    panelMessageId: '',
    groups: {},
    orgRoles: {},
  }));
}

function saveStore(data) {
  writeJson(STORE, data);
}

function publicCatalog(store = loadStore()) {
  return ROLE_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    hint: group.placeholder,
    exclusive: group.exclusive,
    options: group.roles.map((role) => ({
      key: role.key,
      name: role.name,
    })),
  }));
}

function createOnboarding(ctx) {
  const {
    client,
    ops,
    db,
    COLORS,
    PUBLIC_HOST,
    DASHBOARD_LOGIN_URL,
    buildProfileUrl,
    isStaff,
    isCordfolGuild,
  } = ctx;

  async function cordfolGuild() {
    const id = ops.CORDFOL_GUILD_ID;
    if (!id) return null;
    return client.guilds.fetch(id).catch(() => null);
  }

  async function ensureRole(guild, name, { color, hoist = false, mentionable = false } = {}) {
    const existing = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    return guild.roles.create({
      name,
      color,
      hoist,
      mentionable,
      reason: 'Cordfol auto onboarding',
    });
  }

  async function ensureRolesChannel(guild, store) {
    if (store.rolesChannelId) {
      const existing = await guild.channels.fetch(store.rolesChannelId).catch(() => null);
      if (existing) return existing;
    }
    const found = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && ['roles', 'get-roles', 'about-you'].includes(c.name.toLowerCase())
    );
    if (found) return found;

    return guild.channels.create({
      name: 'roles',
      type: ChannelType.GuildText,
      topic: 'Pick roles about you — the bot handles the rest.',
      permissionOverwrites: [
        {
          id: guild.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
      ],
    });
  }

  async function ensureSetup() {
    const guild = await cordfolGuild();
    if (!guild) return { ok: false, reason: 'no_guild' };

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      console.warn('[bot/onboarding] Bot needs Manage Roles to create Pro + about-you roles');
      return { ok: false, reason: 'missing_permission' };
    }

    await guild.roles.fetch().catch(() => {});
    const store = loadStore();

    const proRole = await ensureRole(guild, 'Pro', { color: 0xf0b429, hoist: true, mentionable: true });
    store.proRoleId = proRole.id;
    if (ops) ops.PRO_ROLE_ID = proRole.id;

    store.groups = store.groups || {};
    for (const group of ROLE_GROUPS) {
      const map = {};
      for (const role of group.roles) {
        const created = await ensureRole(guild, role.name, { color: group.color });
        map[role.key] = created.id;
      }
      store.groups[group.id] = map;
    }

    const channel = await ensureRolesChannel(guild, store);
    store.rolesChannelId = channel.id;
    if (ops) ops.ROLES_CHANNEL_ID = channel.id;

    saveStore(store);
    await ensurePanel(channel, store);
    return { ok: true, store, guild, channel, proRole };
  }

  function pageButtonRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(ROLES_PAGE_URL)
        .setLabel('Open roles page')
    );
  }

  function panelEmbed() {
    return new EmbedBuilder()
      .setColor(COLORS?.brand ?? 0xc84dff)
      .setTitle('About you')
      .setDescription(
        `Pick who you are on **[cordfol.org/roles](${ROLES_PAGE_URL})**.\n\n` +
        'Pronouns, what you do, what you care about, and what we can ping you for.\n' +
        'Sign in, tap the chips, and I put the Discord roles on you. **Pro** is granted automatically if you have it.'
      )
      .setFooter({ text: `${PUBLIC_HOST}/roles` });
  }

  async function ensurePanel(channel, store) {
    const payload = {
      embeds: [panelEmbed()],
      components: [pageButtonRow()],
    };

    if (store.panelMessageId) {
      const existing = await channel.messages.fetch(store.panelMessageId).catch(() => null);
      if (existing) {
        await existing.edit(payload).catch(() => {});
        return existing;
      }
    }

    const posted = await channel.send(payload);
    store.panelMessageId = posted.id;
    saveStore(store);
    return posted;
  }

  async function syncMemberPro(memberOrId, wantPro) {
    const guild = await cordfolGuild();
    if (!guild) return { ok: false, reason: 'no_guild' };
    const store = loadStore();
    if (!store.proRoleId) {
      const setup = await ensureSetup();
      if (!setup.ok) return setup;
    }
    const roleId = loadStore().proRoleId;
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return { ok: false, reason: 'no_role' };

    const member = typeof memberOrId === 'string'
      ? await guild.members.fetch(memberOrId).catch(() => null)
      : memberOrId;
    if (!member) return { ok: false, reason: 'not_in_guild' };

    const has = member.roles.cache.has(role.id);
    if (wantPro && !has) {
      await member.roles.add(role, 'Cordfol Pro');
      return { ok: true, changed: 'added' };
    }
    if (!wantPro && has) {
      await member.roles.remove(role, 'Cordfol Pro removed');
      return { ok: true, changed: 'removed' };
    }
    return { ok: true, changed: 'none' };
  }

  async function syncAllProRoles() {
    const guild = await cordfolGuild();
    if (!guild) return;
    const setup = await ensureSetup();
    if (!setup.ok) return;
    const role = setup.proRole;
    const rows = await db.query(`SELECT discord_id, plan FROM users WHERE discord_id IS NOT NULL`);
    const proIds = new Set(rows.rows.filter((r) => isProPlan(r.plan)).map((r) => String(r.discord_id)));

    for (const id of proIds) {
      const member = await guild.members.fetch(id).catch(() => null);
      if (member && !member.roles.cache.has(role.id)) {
        await member.roles.add(role, 'Cordfol Pro sync').catch((err) => {
          console.error('[bot/onboarding] pro add', id, err.message);
        });
      }
    }

    await role.guild.members.fetch().catch(() => {});
    for (const [, member] of role.members) {
      if (member.user.bot) continue;
      if (!proIds.has(member.id)) {
        await member.roles.remove(role, 'Not on Cordfol Pro').catch(() => {});
      }
    }
  }

  async function applyGroupSelection(member, groupId, selectedIds) {
    const store = loadStore();
    const group = ROLE_GROUPS.find((g) => g.id === groupId);
    if (!group) return { ok: false, error: 'Unknown role group.' };
    const known = Object.values(store.groups?.[groupId] || {});
    const selected = new Set(selectedIds.filter((id) => known.includes(id)));

    const toRemove = known.filter((id) => member.roles.cache.has(id) && !selected.has(id));
    const toAdd = [...selected].filter((id) => !member.roles.cache.has(id));

    if (toRemove.length) await member.roles.remove(toRemove, `About-you ${group.title}`);
    if (toAdd.length) await member.roles.add(toAdd, `About-you ${group.title}`);
    return { ok: true, group: group.title, count: selected.size };
  }

  async function snapshotForDiscordId(discordId) {
    await ensureSetup().catch(() => {});
    const store = loadStore();
    const guild = await cordfolGuild();
    const member = discordId && guild
      ? await guild.members.fetch(String(discordId)).catch(() => null)
      : null;
    const groups = publicCatalog(store).map((group) => {
      const ids = store.groups?.[group.id] || {};
      const selected = group.options
        .filter((opt) => member?.roles.cache.has(ids[opt.key]))
        .map((opt) => opt.key);
      return { ...group, selected };
    });
    return {
      groups,
      inGuild: !!member,
      invite: ops.DISCORD_INVITE_URL || 'https://discord.gg/3PCM24s9WT',
      page: ROLES_PAGE_URL,
    };
  }

  async function applyWebSelections(discordId, selections = {}) {
    const setup = await ensureSetup();
    if (!setup.ok) return { ok: false, error: 'Roles are still spinning up. Try again in a minute.' };
    const guild = setup.guild || await cordfolGuild();
    if (!guild) return { ok: false, error: 'Cordfol server is not available.' };
    const member = await guild.members.fetch(String(discordId)).catch(() => null);
    if (!member) {
      return { ok: false, error: 'not_in_guild', invite: ops.DISCORD_INVITE_URL || 'https://discord.gg/3PCM24s9WT' };
    }

    const store = loadStore();
    for (const group of ROLE_GROUPS) {
      const raw = Array.isArray(selections[group.id]) ? selections[group.id] : [];
      const keys = group.exclusive ? raw.slice(0, 1) : raw;
      const allowed = new Set(group.roles.map((r) => r.key));
      const ids = keys
        .filter((key) => allowed.has(key))
        .map((key) => store.groups?.[group.id]?.[key])
        .filter(Boolean);
      await applyGroupSelection(member, group.id, ids);
    }

    try {
      await syncVerifiedRoles(db, member);
    } catch (err) {
      console.error('[bot/onboarding] verify after web pick:', err.message);
    }

    const snap = await snapshotForDiscordId(discordId);
    return { ok: true, ...snap };
  }

  function cleanOrgName(raw) {
    return String(raw || '')
      .replace(/<@!?\d+>/g, '')
      .replace(/["'`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  async function grantOrgRole({ name, targetId } = {}) {
    const guild = await cordfolGuild();
    if (!guild) return { ok: false, error: 'Cordfol server is not available.' };

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      return { ok: false, error: 'I need Manage Roles, above the org roles.' };
    }

    const roleName = cleanOrgName(name);
    if (roleName.length < 2) {
      return { ok: false, error: 'Which org? Say something like “add org role Nightfall”.' };
    }

    await guild.roles.fetch().catch(() => {});
    const store = loadStore();
    store.orgRoles = store.orgRoles || {};
    const key = roleName.toLowerCase();

    let role = null;
    const savedId = store.orgRoles[key]?.id;
    if (savedId) role = await guild.roles.fetch(savedId).catch(() => null);
    if (!role) {
      role = guild.roles.cache.find((r) => r.name.toLowerCase() === key) || null;
    }
    const created = !role;
    if (!role) {
      role = await guild.roles.create({
        name: roleName,
        color: 0xff8a3d,
        hoist: true,
        mentionable: true,
        reason: 'Cordfol org role (founder asked)',
      });
    }

    store.orgRoles[key] = { id: role.id, name: role.name };
    saveStore(store);

    let assigned = null;
    if (targetId) {
      const member = await guild.members.fetch(String(targetId)).catch(() => null);
      if (!member) return { ok: false, error: 'That person is not in the Cordfol server.' };
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role, 'Cordfol org role');
        assigned = 'added';
      } else {
        assigned = 'already';
      }
    }

    return {
      ok: true,
      created,
      assigned,
      role,
      name: role.name,
    };
  }

  async function handleJoin(member) {
    if (!isCordfolGuild(member.guild.id)) return;
    if (member.user.bot) return;

    const setup = await ensureSetup().catch((err) => {
      console.error('[bot/onboarding] setup on join:', err.message);
      return { ok: false };
    });
    const store = loadStore();

    let plan = 'FREE';
    try {
      const row = await db.query('SELECT plan FROM users WHERE discord_id = $1', [member.id]);
      if (row.rowCount) plan = row.rows[0].plan;
    } catch (err) {
      console.error('[bot/onboarding] plan lookup:', err.message);
    }

    if (isProPlan(plan)) {
      await syncMemberPro(member, true).catch((err) => console.error('[bot/onboarding] pro on join:', err.message));
    }

    let verified = { ok: false, reason: 'skipped' };
    try {
      verified = await syncVerifiedRoles(db, member);
    } catch (err) {
      console.error('[bot/onboarding] verify on join:', err.message);
      verified = { ok: false, reason: 'error' };
    }

    let verifyLine = 'I could not sync a Cordfol profile yet.';
    if (verified.reason === 'no_account') {
      verifyLine = `No Cordfol account yet — [sign in on the roles page](${ROLES_PAGE_URL}) and I will pick it up.`;
    } else if (verified.ok && verified.count) {
      verifyLine = `Verified **${verified.count}** role${verified.count === 1 ? '' : 's'} onto [${PUBLIC_HOST}/${verified.slug}](${buildProfileUrl(verified.slug)}).`;
    } else if (verified.ok) {
      verifyLine = `You're on Cordfol as **${verified.slug}**.`;
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS?.brand ?? 0xc84dff)
      .setTitle('Welcome to Cordfol')
      .setDescription(
        `Hey ${member}, I already handled the boring part.\n\n` +
        `${verifyLine}\n` +
        `${isProPlan(plan) ? '⭐ You have **Pro** — I gave you the Pro role.\n' : ''}` +
        `\nOpen **[cordfol.org/roles](${ROLES_PAGE_URL})** and pick who you are.`
      )
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .setFooter({ text: `${PUBLIC_HOST}/roles` });

    const channelId = ops.WELCOME_CHANNEL_ID || ops.ANNOUNCE_CHANNEL_ID || store.rolesChannelId;
    if (channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased()) {
          await channel.send({
            content: `${member}`,
            embeds: [embed],
            components: [pageButtonRow()],
          });
        }
      } catch (err) {
        console.error('[bot/onboarding] welcome channel:', err.message);
      }
    }

    try {
      await member.send({
        embeds: [embed],
        components: [pageButtonRow()],
      });
    } catch {
      // DMs closed — channel message is enough
    }
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId === OPEN_BTN) {
      await interaction.reply({
        ephemeral: true,
        content: `Pick your roles here: ${ROLES_PAGE_URL}`,
        components: [pageButtonRow()],
      });
      return true;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(SELECT_PREFIX)) {
      if (!isCordfolGuild(interaction.guildId)) {
        await interaction.reply({ content: 'Role picks are only in the Cordfol server.', ephemeral: true });
        return true;
      }
      await interaction.deferReply({ ephemeral: true });
      const groupId = interaction.customId.slice(SELECT_PREFIX.length);
      try {
        const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id);
        const result = await applyGroupSelection(member, groupId, interaction.values);
        if (!result.ok) {
          await interaction.editReply({ content: `❌ ${result.error}` });
          return true;
        }
        try {
          await syncVerifiedRoles(db, member);
        } catch { /* profile sync is best-effort after a pick */ }
        await interaction.editReply({
          content: result.count
            ? `✅ Updated **${result.group}**.`
            : `✅ Cleared **${result.group}**.`,
        });
      } catch (err) {
        console.error('[bot/onboarding] select:', err);
        await interaction.editReply({
          content: `❌ I could not assign that role. Drag the Cordfol bot role above the about-you roles. (${err.message})`,
        });
      }
      return true;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'roles') {
      await interaction.reply({
        ephemeral: true,
        content: `Pick roles about you on the site: ${ROLES_PAGE_URL}`,
        components: [pageButtonRow()],
      });
      return true;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'roles-panel') {
      await interaction.deferReply({ ephemeral: true });
      if (!isCordfolGuild(interaction.guildId)) {
        await interaction.editReply({ content: '❌ Cordfol server only.' });
        return true;
      }
      if (!isStaff(interaction.member, interaction.user.id)) {
        await interaction.editReply({ content: '❌ Staff only.' });
        return true;
      }
      const setup = await ensureSetup();
      if (!setup.ok) {
        await interaction.editReply({ content: `❌ Could not set up roles: ${setup.reason}` });
        return true;
      }
      await interaction.editReply({ content: `✅ Discord pointer is live in ${setup.channel}. The picker is ${ROLES_PAGE_URL}` });
      return true;
    }

    return false;
  }

  function rolesChannelId() {
    return loadStore().rolesChannelId || ops.ROLES_CHANNEL_ID || '';
  }

  return {
    ensureSetup,
    syncMemberPro,
    syncAllProRoles,
    handleJoin,
    handleInteraction,
    grantOrgRole,
    cleanOrgName,
    snapshotForDiscordId,
    applyWebSelections,
    rolesChannelId,
    ROLES_PAGE_URL,
    OPEN_BTN,
  };
}

module.exports = { createOnboarding, ROLE_GROUPS, publicCatalog, ROLES_PAGE_URL };
