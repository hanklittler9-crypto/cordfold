// Cordfol guild action / member / message logging → LOG_CHANNEL_ID
const { EmbedBuilder, AuditLogEvent } = require('discord.js');

const COLORS = {
  join: 0x3dd68c,
  leave: 0xf0b429,
  delete: 0xff4d6d,
  edit: 0x5865F2,
  ban: 0xff4d6d,
  mod: 0xc84dff,
  ticket: 0xc84dff,
  modmail: 0x5865F2,
};

function truncate(text, max = 900) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function createLogger(ctx) {
  const { client, CORDFOL_GUILD_ID, LOG_CHANNEL_ID, PUBLIC_HOST } = ctx;

  async function sendLog({ title, description, color, fields = [] }) {
    if (!LOG_CHANNEL_ID) return;
    try {
      const channel = await client.channels.fetch(LOG_CHANNEL_ID);
      if (!channel?.isTextBased()) return;
      const embed = new EmbedBuilder()
        .setColor(color ?? COLORS.mod)
        .setTitle(title)
        .setDescription(description || null)
        .setFooter({ text: `${PUBLIC_HOST || 'cordfol.org'} · Server log` })
        .setTimestamp();
      for (const f of fields.slice(0, 20)) {
        if (f?.name && f?.value) embed.addFields({ name: f.name, value: String(f.value).slice(0, 1020), inline: !!f.inline });
      }
      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.error('[bot/logging] sendLog:', err.message);
    }
  }

  function isCordfolGuild(guildId) {
    return guildId && String(guildId) === String(CORDFOL_GUILD_ID);
  }

  function register() {
    client.on('guildMemberAdd', async (member) => {
      if (!isCordfolGuild(member.guild.id)) return;
      await sendLog({
        title: 'Member joined',
        color: COLORS.join,
        description: `${member} (\`${member.user.tag}\`)`,
        fields: [
          { name: 'User ID', value: member.id, inline: true },
          { name: 'Account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
        ],
      });
    });

    client.on('guildMemberRemove', async (member) => {
      if (!isCordfolGuild(member.guild.id)) return;
      await sendLog({
        title: 'Member left',
        color: COLORS.leave,
        description: `${member.user?.tag || 'Unknown'} (\`${member.id}\`)`,
        fields: [{ name: 'User ID', value: member.id, inline: true }],
      });
    });

    client.on('messageDelete', async (message) => {
      if (!message.guild || !isCordfolGuild(message.guild.id)) return;
      if (message.author?.bot) return;
      await sendLog({
        title: 'Message deleted',
        color: COLORS.delete,
        description: truncate(message.content || '_No text content / embed only_'),
        fields: [
          { name: 'Author', value: message.author ? `${message.author.tag} (\`${message.author.id}\`)` : 'Unknown', inline: true },
          { name: 'Channel', value: message.channel ? `<#${message.channel.id}>` : 'Unknown', inline: true },
        ],
      });
    });

    client.on('messageUpdate', async (oldMessage, newMessage) => {
      if (!newMessage.guild || !isCordfolGuild(newMessage.guild.id)) return;
      if (newMessage.author?.bot) return;
      const before = oldMessage.content || '';
      const after = newMessage.content || '';
      if (before === after) return;
      await sendLog({
        title: 'Message edited',
        color: COLORS.edit,
        fields: [
          { name: 'Author', value: newMessage.author ? `${newMessage.author.tag}` : 'Unknown', inline: true },
          { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
          { name: 'Before', value: truncate(before || '_empty_') },
          { name: 'After', value: truncate(after || '_empty_') },
          { name: 'Jump', value: `[Open](${newMessage.url})` },
        ],
      });
    });

    client.on('guildBanAdd', async (ban) => {
      if (!isCordfolGuild(ban.guild.id)) return;
      let moderator = 'Unknown';
      try {
        const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 });
        const entry = logs.entries.first();
        if (entry && entry.target?.id === ban.user.id && Date.now() - entry.createdTimestamp < 15000) {
          moderator = `${entry.executor.tag} (\`${entry.executor.id}\`)`;
        }
      } catch { /* ignore */ }
      await sendLog({
        title: 'Member banned',
        color: COLORS.ban,
        description: `${ban.user.tag} (\`${ban.user.id}\`)`,
        fields: [
          { name: 'Moderator', value: moderator, inline: true },
          { name: 'Reason', value: ban.reason || '_No reason_', inline: true },
        ],
      });
    });
  }

  return { sendLog, register, COLORS };
}

module.exports = { createLogger };
