// Private-channel ticket system for the Cordfol guild
const path = require('path');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { readJson, writeJson } = require('./json-store');

const STORE = path.join(__dirname, 'data', 'tickets.json');
const OPEN_BTN = 'cordfol_ticket_open';
const CLOSE_BTN = 'cordfol_ticket_close';

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

function createTickets(ctx) {
  const {
    client,
    CORDFOL_GUILD_ID,
    TICKET_CATEGORY_ID,
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
        .setName('ticket-panel')
        .setDescription('Post the support ticket panel in this channel (staff)')
        .toJSON(),
      new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Ticket helpers')
        .addSubcommand((s) => s.setName('close').setDescription('Close the current ticket'))
        .toJSON(),
    ];
  }

  async function postPanel(channel) {
    const embed = new EmbedBuilder()
      .setColor(COLORS?.brand ?? 0xc84dff)
      .setTitle('Cordfol Support Tickets')
      .setDescription(
        'Need help with your profile, verification, or the site?\n\n' +
        'Click **Open ticket** and staff will help you in a private channel.'
      )
      .setFooter({ text: 'cordfol.org · Support' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(OPEN_BTN)
        .setLabel('Open ticket')
        .setStyle(ButtonStyle.Primary)
    );

    return channel.send({ embeds: [embed], components: [row] });
  }

  async function openTicket(member, guild) {
    if (!TICKET_CATEGORY_ID) {
      return { ok: false, error: 'TICKET_CATEGORY_ID is not configured.' };
    }

    const store = loadStore();
    const existingId = store.byUser[member.id];
    if (existingId) {
      const existing = guild.channels.cache.get(existingId) || await guild.channels.fetch(existingId).catch(() => null);
      if (existing) return { ok: true, channel: existing, reused: true };
      delete store.byUser[member.id];
      delete store.byChannel[existingId];
      saveStore(store);
    }

    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ReadMessageHistory,
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
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    const channel = await guild.channels.create({
      name: `ticket-${slugName(member.user.username)}`,
      type: ChannelType.GuildText,
      parent: TICKET_CATEGORY_ID,
      topic: `Ticket for ${member.user.tag} (${member.id})`,
      permissionOverwrites: overwrites,
    });

    store.byUser[member.id] = channel.id;
    store.byChannel[channel.id] = { userId: member.id, openedAt: new Date().toISOString() };
    saveStore(store);

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CLOSE_BTN)
        .setLabel('Close ticket')
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      content: `${member} — staff will be with you shortly.`,
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS?.brand ?? 0xc84dff)
          .setTitle('Ticket opened')
          .setDescription(`Describe your issue here.\nStaff can close with the button or \`${BOT_PREFIX}close\`.`)
          .setFooter({ text: `User ID ${member.id}` }),
      ],
      components: [closeRow],
    });

    if (sendLog) {
      await sendLog({
        title: 'Ticket opened',
        color: COLORS?.ticket ?? 0xc84dff,
        description: `${member.user.tag} → ${channel}`,
        fields: [{ name: 'User ID', value: member.id, inline: true }],
      });
    }

    return { ok: true, channel, reused: false };
  }

  async function closeTicket(channel, closer) {
    const store = loadStore();
    const meta = store.byChannel[channel.id];
    if (!meta) return { ok: false, error: 'This is not an open ticket channel.' };

    delete store.byChannel[channel.id];
    if (store.byUser[meta.userId] === channel.id) delete store.byUser[meta.userId];
    saveStore(store);

    if (sendLog) {
      await sendLog({
        title: 'Ticket closed',
        color: COLORS?.ticket ?? 0xc84dff,
        description: `#${channel.name} closed by ${closer.tag || closer.username}`,
        fields: [{ name: 'Owner', value: meta.userId, inline: true }],
      });
    }

    await channel.send({ content: `Ticket closed by ${closer}. Channel deletes in 5s…` }).catch(() => {});
    setTimeout(() => {
      channel.delete('Ticket closed').catch((err) => console.error('[bot/tickets] delete:', err.message));
    }, 5000);

    return { ok: true };
  }

  function isTicketChannel(channelId) {
    return !!loadStore().byChannel[channelId];
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton()) {
      if (interaction.customId === OPEN_BTN) {
        if (String(interaction.guildId) !== String(CORDFOL_GUILD_ID)) {
          await interaction.reply({ content: 'Tickets are only available in the Cordfol server.', ephemeral: true });
          return true;
        }
        await interaction.deferReply({ ephemeral: true });
        try {
          const result = await openTicket(interaction.member, interaction.guild);
          if (!result.ok) {
            await interaction.editReply({ content: `❌ ${result.error}` });
            return true;
          }
          await interaction.editReply({
            content: result.reused
              ? `You already have a ticket: ${result.channel}`
              : `Ticket created: ${result.channel}`,
          });
        } catch (err) {
          console.error('[bot/tickets] open:', err);
          await interaction.editReply({ content: `❌ Could not open ticket: ${err.message}` });
        }
        return true;
      }

      if (interaction.customId === CLOSE_BTN) {
        await interaction.deferReply({ ephemeral: true });
        const staffOk = isStaff(interaction.member, interaction.user.id);
        const store = loadStore();
        const meta = store.byChannel[interaction.channelId];
        const isOwner = meta && meta.userId === interaction.user.id;
        if (!staffOk && !isOwner) {
          await interaction.editReply({ content: '❌ Only the ticket owner or staff can close this.' });
          return true;
        }
        const result = await closeTicket(interaction.channel, interaction.user);
        await interaction.editReply({ content: result.ok ? '✅ Closing ticket…' : `❌ ${result.error}` });
        return true;
      }
    }

    if (!interaction.isChatInputCommand()) return false;

    if (interaction.commandName === 'ticket-panel') {
      await interaction.deferReply({ ephemeral: true });
      if (String(interaction.guildId) !== String(CORDFOL_GUILD_ID)) {
        await interaction.editReply({ content: '❌ Cordfol server only.' });
        return true;
      }
      if (!isStaff(interaction.member, interaction.user.id)) {
        await interaction.editReply({ content: '❌ Staff only.' });
        return true;
      }
      await postPanel(interaction.channel);
      await interaction.editReply({ content: '✅ Ticket panel posted.' });
      return true;
    }

    if (interaction.commandName === 'ticket') {
      await interaction.deferReply({ ephemeral: true });
      if (interaction.options.getSubcommand() === 'close') {
        const staffOk = isStaff(interaction.member, interaction.user.id);
        const store = loadStore();
        const meta = store.byChannel[interaction.channelId];
        const isOwner = meta && meta.userId === interaction.user.id;
        if (!staffOk && !isOwner) {
          await interaction.editReply({ content: '❌ Staff or ticket owner only.' });
          return true;
        }
        const result = await closeTicket(interaction.channel, interaction.user);
        await interaction.editReply({ content: result.ok ? '✅ Closing…' : `❌ ${result.error}` });
      }
      return true;
    }

    return false;
  }

  async function handlePrefix(message, cmd) {
    if (cmd !== 'close' && cmd !== 'ticket') return false;
    if (!isTicketChannel(message.channel.id)) {
      if (cmd === 'close') return false;
      return false;
    }
    const store = loadStore();
    const meta = store.byChannel[message.channel.id];
    const staffOk = isStaff(message.member, message.author.id);
    const isOwner = meta && meta.userId === message.author.id;
    if (!staffOk && !isOwner) {
      await message.reply('❌ Staff or ticket owner only.');
      return true;
    }
    const result = await closeTicket(message.channel, message.author);
    if (!result.ok) await message.reply(`❌ ${result.error}`);
    return true;
  }

  return { slashCommands, handleInteraction, handlePrefix, isTicketChannel };
}

module.exports = { createTickets };
