// Light moderation tools for the Cordfol guild
const { EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

function parseDuration(input) {
  if (!input) return 10 * 60 * 1000; // default 10m
  const m = String(input).trim().match(/^(\d+)(s|m|h|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  const ms = n * mult;
  if (ms < 5000 || ms > 28 * 86_400_000) return null;
  return ms;
}

function createModeration(ctx) {
  const { BOT_PREFIX, isStaff, sendLog, COLORS, ops } = ctx;

  function slashCommands() {
    return [
      new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Warn a member (staff)')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Timeout a member (staff)')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 1h, 1d').setRequired(false))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a member (staff)')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member (staff)')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false))
        .toJSON(),
      new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete recent messages in this channel (staff)')
        .addIntegerOption((o) =>
          o.setName('count').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)
        )
        .toJSON(),
    ];
  }

  async function logAction(action, moderator, target, reason, extra = {}) {
    if (!sendLog) return;
    await sendLog({
      title: `Mod · ${action}`,
      color: COLORS?.mod ?? 0xc84dff,
      description: `**Target:** ${target?.tag || target} (\`${target?.id || '?'}\`)`,
      fields: [
        { name: 'Moderator', value: `${moderator.tag} (\`${moderator.id}\`)`, inline: true },
        { name: 'Reason', value: reason || '_No reason_', inline: true },
        ...Object.entries(extra).map(([name, value]) => ({ name, value: String(value), inline: true })),
      ],
    });
  }

  async function dmUser(user, title, body) {
    try {
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS?.mod ?? 0xc84dff)
            .setTitle(title)
            .setDescription(body)
            .setFooter({ text: 'Cordfol moderation' }),
        ],
      });
    } catch { /* ignore */ }
  }

  async function doWarn({ guild, moderator, target, reason, reply }) {
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (!member) return reply({ content: '❌ Member not found in this server.' });
    await dmUser(target, 'You were warned in Cordfol', reason || 'No reason provided.');
    await logAction('Warn', moderator, target, reason);
    return reply({ content: `✅ Warned **${target.tag}**.` });
  }

  async function doTimeout({ guild, moderator, target, durationMs, reason, reply }) {
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (!member) return reply({ content: '❌ Member not found.' });
    if (!member.moderatable) return reply({ content: '❌ I cannot timeout that member.' });
    await member.timeout(durationMs, reason || `Timed out by ${moderator.tag}`);
    await dmUser(
      target,
      'You were timed out in Cordfol',
      `${reason || 'No reason'}\nDuration: ${Math.round(durationMs / 60000)}m`
    );
    await logAction('Timeout', moderator, target, reason, {
      Duration: `${Math.round(durationMs / 60000)}m`,
    });
    return reply({ content: `✅ Timed out **${target.tag}** for ${Math.round(durationMs / 60000)}m.` });
  }

  async function doKick({ guild, moderator, target, reason, reply }) {
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (!member) return reply({ content: '❌ Member not found.' });
    if (!member.kickable) return reply({ content: '❌ I cannot kick that member.' });
    await dmUser(target, 'You were kicked from Cordfol', reason || 'No reason provided.');
    await member.kick(reason || `Kicked by ${moderator.tag}`);
    await logAction('Kick', moderator, target, reason);
    return reply({ content: `✅ Kicked **${target.tag}**.` });
  }

  async function doBan({ guild, moderator, target, reason, reply }) {
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (member && !member.bannable) return reply({ content: '❌ I cannot ban that member.' });
    await dmUser(target, 'You were banned from Cordfol', reason || 'No reason provided.');
    await guild.members.ban(target.id, { reason: reason || `Banned by ${moderator.tag}`, deleteMessageSeconds: 0 });
    await logAction('Ban', moderator, target, reason);
    return reply({ content: `✅ Banned **${target.tag}**.` });
  }

  async function doPurge({ channel, moderator, count, reply }) {
    if (!channel?.bulkDelete) return reply({ content: '❌ Cannot purge here.' });
    const deleted = await channel.bulkDelete(count, true);
    await logAction('Purge', moderator, { tag: `#${channel.name}`, id: channel.id }, `${deleted.size} messages`);
    return reply({ content: `✅ Deleted **${deleted.size}** messages.` });
  }

  async function handleInteraction(interaction) {
    const name = interaction.commandName;
    if (!['warn', 'timeout', 'kick', 'ban', 'purge'].includes(name)) return false;

    await interaction.deferReply({ ephemeral: true });
    if (String(interaction.guildId) !== String(ops.CORDFOL_GUILD_ID)) {
      await interaction.editReply({ content: '❌ Cordfol server only.' });
      return true;
    }
    if (!isStaff(interaction.member, interaction.user.id)) {
      await interaction.editReply({ content: '❌ Staff only.' });
      return true;
    }

    const reply = (payload) => interaction.editReply(payload);
    const moderator = interaction.user;

    if (name === 'purge') {
      const count = interaction.options.getInteger('count');
      await doPurge({ channel: interaction.channel, moderator, count, reply });
      return true;
    }

    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || undefined;

    if (name === 'warn') {
      await doWarn({ guild: interaction.guild, moderator, target, reason, reply });
    } else if (name === 'timeout') {
      const durationMs = parseDuration(interaction.options.getString('duration') || '10m');
      if (!durationMs) {
        await reply({ content: '❌ Invalid duration. Use e.g. `10m`, `1h`, `1d` (max 28d).' });
        return true;
      }
      await doTimeout({ guild: interaction.guild, moderator, target, durationMs, reason, reply });
    } else if (name === 'kick') {
      await doKick({ guild: interaction.guild, moderator, target, reason, reply });
    } else if (name === 'ban') {
      await doBan({ guild: interaction.guild, moderator, target, reason, reply });
    }
    return true;
  }

  async function handlePrefix(message, cmd, rest, argsText) {
    if (!['warn', 'timeout', 'kick', 'ban', 'purge'].includes(cmd)) return false;
    if (String(message.guild?.id) !== String(ops.CORDFOL_GUILD_ID)) {
      await message.reply('❌ Cordfol server only.');
      return true;
    }
    if (!isStaff(message.member, message.author.id)) {
      await message.reply('❌ Staff only.');
      return true;
    }

    const reply = (payload) => message.reply(payload);
    const moderator = message.author;

    if (cmd === 'purge') {
      const count = Math.min(100, Math.max(1, parseInt(rest[0], 10) || 0));
      if (!count) {
        await reply({ content: `Usage: \`${BOT_PREFIX}purge <1-100>\`` });
        return true;
      }
      await doPurge({ channel: message.channel, moderator, count, reply });
      return true;
    }

    const target = message.mentions.users.first();
    if (!target) {
      await reply({ content: `Usage: \`${BOT_PREFIX}${cmd} @user [reason]\`` });
      return true;
    }

    if (cmd === 'timeout') {
      // .timeout @user 10m reason...
      const durToken = rest.find((t) => /^\d+(s|m|h|d)?$/i.test(t) && !t.startsWith('<@'));
      const durationMs = parseDuration(durToken || '10m');
      if (!durationMs) {
        await reply({ content: '❌ Invalid duration.' });
        return true;
      }
      const reason = argsText
        .replace(/<@!?\d+>/g, '')
        .replace(durToken || '', '')
        .trim() || undefined;
      await doTimeout({ guild: message.guild, moderator, target, durationMs, reason, reply });
      return true;
    }

    const reason = argsText.replace(/<@!?\d+>/g, '').trim() || undefined;
    if (cmd === 'warn') await doWarn({ guild: message.guild, moderator, target, reason, reply });
    if (cmd === 'kick') await doKick({ guild: message.guild, moderator, target, reason, reply });
    if (cmd === 'ban') await doBan({ guild: message.guild, moderator, target, reason, reply });
    return true;
  }

  return { slashCommands, handleInteraction, handlePrefix };
}

module.exports = { createModeration, parseDuration };
