// Auto-create Cordfol ops channels/categories and upsert .env
const fs = require('fs');
const path = require('path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

function envPath() {
  return process.env.DOTENV_PATH || path.join(process.cwd(), '.env');
}

function upsertEnv(updates) {
  const file = envPath();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }

  const lines = text ? text.split(/\r?\n/) : [];
  const keys = Object.keys(updates);
  const seen = new Set();

  const next = lines.map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) return line;
    const key = m[1];
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });

  for (const key of keys) {
    if (!seen.has(key)) next.push(`${key}=${updates[key]}`);
  }

  // Ensure trailing newline
  const out = next.join('\n').replace(/\n*$/, '\n');
  fs.writeFileSync(file, out, 'utf8');
  return file;
}

async function channelExists(guild, id) {
  if (!id) return false;
  try {
    const ch = await guild.channels.fetch(id);
    return !!ch;
  } catch {
    return false;
  }
}

async function ensureCategory(guild, name, overwrites) {
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing;
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
  });
}

async function ensureText(guild, name, parentId, overwrites) {
  const existing = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name.toLowerCase() === name.toLowerCase() &&
      (!parentId || c.parentId === parentId)
  );
  if (existing) return existing;
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId || undefined,
    topic: 'Cordfol bot ops — managed automatically',
    permissionOverwrites: overwrites,
  });
}

/**
 * Ensure logs channel + ticket/modmail categories exist, write IDs into ops + .env
 * @param {import('discord.js').Client} client
 * @param {object} ops mutable ops config
 */
async function ensureGuildOps(client, ops) {
  const guildId = ops.CORDFOL_GUILD_ID;
  if (!guildId) {
    console.warn('[bot/setup] CORDFOL_GUILD_ID missing — skip auto channel setup');
    return { ok: false, reason: 'no_guild' };
  }

  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (err) {
    console.error('[bot/setup] Cannot fetch Cordfol guild:', err.message);
    return { ok: false, reason: 'guild_fetch', error: err.message };
  }

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    console.error('[bot/setup] Bot needs Manage Channels to auto-create ops channels');
    return { ok: false, reason: 'missing_permission' };
  }

  const staffRoleIds = [...new Set([...(ops.STAFF_ROLE_IDS || []), ...(ops.ADMIN_ROLE_IDS || [])])];

  const staffOverwrites = staffRoleIds.map((id) => ({
    id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ManageMessages,
    ],
  }));

  const privateBase = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    ...staffOverwrites,
  ];

  const created = [];
  const updates = {};

  // Ops category + #logs
  let logId = ops.LOG_CHANNEL_ID;
  if (!(await channelExists(guild, logId))) {
    const opsCat = await ensureCategory(guild, 'Cordfol Ops', [
      {
        id: guild.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: client.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.SendMessages],
      },
      ...staffOverwrites,
    ]);
    const logs = await ensureText(guild, 'logs', opsCat.id, [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      ...staffOverwrites,
    ]);
    logId = logs.id;
    created.push(`#logs (${logId})`);
  }
  ops.LOG_CHANNEL_ID = logId;
  process.env.LOG_CHANNEL_ID = logId;
  updates.LOG_CHANNEL_ID = logId;

  // Tickets category
  let ticketCatId = ops.TICKET_CATEGORY_ID;
  if (!(await channelExists(guild, ticketCatId))) {
    const cat = await ensureCategory(guild, 'Tickets', privateBase);
    ticketCatId = cat.id;
    created.push(`Tickets category (${ticketCatId})`);
  }
  ops.TICKET_CATEGORY_ID = ticketCatId;
  process.env.TICKET_CATEGORY_ID = ticketCatId;
  updates.TICKET_CATEGORY_ID = ticketCatId;

  // Modmail category
  let modmailCatId = ops.MODMAIL_CATEGORY_ID;
  if (!(await channelExists(guild, modmailCatId))) {
    const cat = await ensureCategory(guild, 'Modmail', privateBase);
    modmailCatId = cat.id;
    created.push(`Modmail category (${modmailCatId})`);
  }
  ops.MODMAIL_CATEGORY_ID = modmailCatId;
  process.env.MODMAIL_CATEGORY_ID = modmailCatId;
  updates.MODMAIL_CATEGORY_ID = modmailCatId;

  // Always persist known IDs
  if (ops.CORDFOL_GUILD_ID) updates.CORDFOL_GUILD_ID = ops.CORDFOL_GUILD_ID;
  if (ops.DISCORD_INVITE_URL) updates.DISCORD_INVITE_URL = ops.DISCORD_INVITE_URL;

  let envFile;
  try {
    envFile = upsertEnv(updates);
    console.log(`[bot/setup] Updated ${envFile} with ops channel IDs`);
  } catch (err) {
    console.error('[bot/setup] Could not write .env:', err.message);
    return { ok: true, created, updates, envError: err.message };
  }

  if (created.length) {
    console.log(`[bot/setup] Created: ${created.join(', ')}`);
  } else {
    console.log('[bot/setup] Ops channels already configured');
  }

  return { ok: true, created, updates, envFile };
}

module.exports = { ensureGuildOps, upsertEnv, envPath };
