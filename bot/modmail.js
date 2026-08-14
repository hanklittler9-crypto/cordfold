// DM modmail → private staff channels under MODMAIL_CATEGORY_ID
const path = require('path');
const {
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { readJson, writeJson } = require('./json-store');

const STORE = path.join(__dirname, 'data', 'modmail.json');

function loadStore() {
  return readJson(STORE, () => ({ byUser: {}, byChannel: {} }));
}

function saveStore(data) {
  writeJson(STORE, data);
}

function slugName(username) {
  return String(username || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'user';
}

function createModmail(ctx) {
  const {
    client,
    CORDFOL_GUILD_ID,
    MODMAIL_CATEGORY_ID,
    STAFF_ROLE_IDS,
    ADMIN_ROLE_IDS,
    BOT_PREFIX,
    isStaff,
    sendLog,
    COLORS,
  } = ctx;

  const staffRoleIds = [...new Set([...(STAFF_ROLE_IDS || []), ...(ADMIN_ROLE_IDS || [])])];

  function slashCommands() {
    return [
      new SlashCommandBuilder()
        .setName('modmail')
        .setDescription('Modmail helpers (staff)')
        .addSubcommand((s) => s.setName('close').setDescription('Close this modmail thread'))
        .toJSON(),
    ];
  }

  async function getGuild() {
    return client.guilds.fetch(CORDFOL_GUILD_ID);
  }

  async function ensureThread(user) {
    if (!MODMAIL_CATEGORY_ID) {
      return { ok: false, error: 'MODMAIL_CATEGORY_ID is not configured.' };
    }

    const store = loadStore();
    const existingId = store.byUser[user.id];
    const guild = await getGuild();

    if (existingId) {
      const existing = guild.channels.cache.get(existingId)
        || await guild.channels.fetch(existingId).catch(() => null);
      if (existing) return { ok: true, channel: existing, guild, reused: true };
      delete store.byUser[user.id];
      delete store.byChannel[existingId];
      saveStore(store);
    }

    const overwrites = [
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
    ];
    for (const roleId of staffRoleIds) {
      overwrites.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }

    const channel = await guild.channels.create({
      name: `mail-${slugName(user.username)}`,
      type: ChannelType.GuildText,
      parent: MODMAIL_CATEGORY_ID,
      topic: `Modmail with ${user.tag} (${user.id})`,
      permissionOverwrites: overwrites,
    });

    store.byUser[user.id] = channel.id;
    store.byChannel[channel.id] = { userId: user.id, openedAt: new Date().toISOString() };
    saveStore(store);

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS?.discord ?? 0x5865F2)
          .setTitle('New modmail')
          .setDescription(`Conversation with **${user.tag}** (\`${user.id}\`).\nReply in this channel to message them.\nClose with \`${BOT_PREFIX}close\` or \`/modmail close\`.`)
          .setThumbnail(user.displayAvatarURL({ size: 128 })),
      ],
    });

    if (sendLog) {
      await sendLog({
        title: 'Modmail opened',
        color: COLORS?.modmail ?? 0x5865F2,
        description: `${user.tag} → ${channel}`,
        fields: [{ name: 'User ID', value: user.id, inline: true }],
      });
    }

    return { ok: true, channel, guild, reused: false };
  }

  async function closeMail(channel, closer) {
    const store = loadStore();
    const meta = store.byChannel[channel.id];
    if (!meta) return { ok: false, error: 'Not a modmail channel.' };

    delete store.byChannel[channel.id];
    if (store.byUser[meta.userId] === channel.id) delete store.byUser[meta.userId];
    saveStore(store);

    try {
      const user = await client.users.fetch(meta.userId);
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS?.brand ?? 0xc84dff)
            .setTitle('Modmail closed')
            .setDescription('Your conversation with Cordfol staff has been closed. DM me again anytime for help.'),
        ],
      });
    } catch { /* DMs closed */ }

    if (sendLog) {
      await sendLog({
        title: 'Modmail closed',
        color: COLORS?.modmail ?? 0x5865F2,
        description: `#${channel.name} by ${closer.tag || closer.username}`,
        fields: [{ name: 'User', value: meta.userId, inline: true }],
      });
    }

    await channel.send(`Closed by ${closer}. Deleting in 5s…`).catch(() => {});
    setTimeout(() => {
      channel.delete('Modmail closed').catch((err) => console.error('[bot/modmail] delete:', err.message));
    }, 5000);

    return { ok: true };
  }

  function isMailChannel(channelId) {
    return !!loadStore().byChannel[channelId];
  }

  async function handleDm(message) {
    if (message.author.bot) return false;
    if (message.guild) return false;

    const content = (message.content || '').trim();
    if (!content && message.attachments.size === 0) return true;

    try {
      await message.channel.sendTyping();
      const result = await ensureThread(message.author);
      if (!result.ok) {
        await message.reply(`❌ Modmail unavailable: ${result.error}`);
        return true;
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS?.discord ?? 0x5865F2)
        .setAuthor({
          name: message.author.tag,
          iconURL: message.author.displayAvatarURL({ size: 64 }),
        })
        .setDescription(content || '_Attachment only_')
        .setFooter({ text: `User ID ${message.author.id}` })
        .setTimestamp();

      const files = [...message.attachments.values()].map((a) => a.url);
      await result.channel.send({ embeds: [embed], files: files.slice(0, 5) });

      if (!result.reused) {
        await message.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS?.brand ?? 0xc84dff)
              .setDescription('Your message was sent to Cordfol staff. Replies will show up here.'),
          ],
        });
      } else {
        await message.react('✅').catch(() => {});
      }
    } catch (err) {
      console.error('[bot/modmail] dm:', err);
      await message.reply('❌ Could not deliver your message. Try again later.').catch(() => {});
    }
    return true;
  }

  async function handleStaffRelay(message) {
    if (!message.guild || message.author.bot) return false;
    if (String(message.guild.id) !== String(CORDFOL_GUILD_ID)) return false;
    if (!isMailChannel(message.channel.id)) return false;

    // Don't relay commands
    if (message.content.startsWith(BOT_PREFIX)) return false;

    const store = loadStore();
    const meta = store.byChannel[message.channel.id];
    if (!meta) return false;

    try {
      const user = await client.users.fetch(meta.userId);
      const embed = new EmbedBuilder()
        .setColor(COLORS?.brand ?? 0xc84dff)
        .setAuthor({
          name: `Cordfol Staff · ${message.author.username}`,
          iconURL: message.author.displayAvatarURL({ size: 64 }),
        })
        .setDescription(message.content || '_Attachment only_')
        .setFooter({ text: 'Reply to this DM to continue the conversation' })
        .setTimestamp();

      const files = [...message.attachments.values()].map((a) => a.url);
      await user.send({ embeds: [embed], files: files.slice(0, 5) });
      await message.react('✅').catch(() => {});
    } catch (err) {
      await message.reply(`❌ Could not DM user: ${err.message}`).catch(() => {});
    }
    return true;
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'modmail') return false;
    await interaction.deferReply({ ephemeral: true });
    if (!isStaff(interaction.member, interaction.user.id)) {
      await interaction.editReply({ content: '❌ Staff only.' });
      return true;
    }
    if (interaction.options.getSubcommand() === 'close') {
      const result = await closeMail(interaction.channel, interaction.user);
      await interaction.editReply({ content: result.ok ? '✅ Closing…' : `❌ ${result.error}` });
    }
    return true;
  }

  async function handlePrefix(message, cmd) {
    if (cmd !== 'close' && cmd !== 'modmail') return false;
    if (!isMailChannel(message.channel.id)) return false;
    if (!isStaff(message.member, message.author.id)) {
      await message.reply('❌ Staff only.');
      return true;
    }
    const result = await closeMail(message.channel, message.author);
    if (!result.ok) await message.reply(`❌ ${result.error}`);
    return true;
  }

  return {
    slashCommands,
    handleDm,
    handleStaffRelay,
    handleInteraction,
    handlePrefix,
    isMailChannel,
  };
}

module.exports = { createModmail };
