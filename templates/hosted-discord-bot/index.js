const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (err) {
  console.error('[hosted-bot] missing config.json:', err.message);
}

const token = process.env.DISCORD_TOKEN;
const prefix = String(config.prefix || process.env.BOT_PREFIX || '!').slice(0, 8) || '!';
const status = String(config.status || process.env.BOT_STATUS || '').slice(0, 80);
const commands = Array.isArray(config.commands) ? config.commands : [];

if (!token) {
  console.error('[hosted-bot] DISCORD_TOKEN is missing');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`[hosted-bot] logged in as ${client.user.tag}`);
  if (status) {
    client.user.setPresence({ activities: [{ name: status }], status: 'online' }).catch(() => {});
  }
});

client.on('messageCreate', (msg) => {
  if (msg.author.bot || !msg.content.startsWith(prefix)) return;
  const name = msg.content.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase();
  if (!name) return;

  if (name === 'ping') {
    msg.reply('pong').catch(() => {});
    return;
  }

  if (name === 'help') {
    const extra = commands.map((c) => `${prefix}${c.name}`).join(', ');
    const list = extra ? `${prefix}ping, ${prefix}help, ${extra}` : `${prefix}ping, ${prefix}help`;
    msg.reply(`Commands: ${list}`).catch(() => {});
    return;
  }

  const cmd = commands.find((c) => c.name === name);
  if (cmd) msg.reply(cmd.reply).catch(() => {});
});

client.login(token).catch((err) => {
  console.error('[hosted-bot] login failed:', err.message);
  process.exit(1);
});
