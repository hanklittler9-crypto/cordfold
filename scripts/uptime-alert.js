#!/usr/bin/env node
/**
 * Cordfol uptime alerter — cron this every 1–2 minutes.
 * Emails on DOWN and RECOVERY (not every check).
 *
 *   node scripts/uptime-alert.js
 *
 * Env (from ~/.env or process env):
 *   SMTP_USER, SMTP_PASS, SMTP_FROM
 *   UPTIME_ALERT_TO   (defaults to SMTP_FROM / SMTP_USER)
 *   UPTIME_CHECK_URLS (comma-separated, default localhost + public)
 *   UPTIME_STATE_FILE (default ~/.cordfol-uptime-state.json)
 */
require('dotenv').config({ path: require('path').join(require('os').homedir(), '.env') });
require('dotenv').config(); // also allow cwd .env

const fs = require('fs');
const os = require('os');
const path = require('path');
const nodemailer = require('nodemailer');

const STATE_FILE =
  process.env.UPTIME_STATE_FILE ||
  path.join(os.homedir(), '.cordfol-uptime-state.json');

const ALERT_TO =
  process.env.UPTIME_ALERT_TO ||
  process.env.SMTP_FROM ||
  process.env.SMTP_USER;

const URLS = (process.env.UPTIME_CHECK_URLS ||
  'http://127.0.0.1:3000/,https://cordfol.org/,https://api.cordfol.org/api/auth/me'
).split(',').map((s) => s.trim()).filter(Boolean);

const TIMEOUT_MS = Number(process.env.UPTIME_TIMEOUT_MS || 12000);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { up: true, since: null, lastAlertAt: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function checkUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'cordfol-uptime-alert/1.0' },
    });
    // 401 on /auth/me still means API is up
    const ok = res.status > 0 && res.status < 500;
    return { url, ok, status: res.status };
  } catch (err) {
    return { url, ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function sendAlert(subject, text) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass || !ALERT_TO) {
    console.error('[uptime] SMTP not configured or UPTIME_ALERT_TO missing');
    return false;
  }
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  await transport.sendMail({
    from: `"Cordfol Alerts" <${process.env.SMTP_FROM || user}>`,
    to: ALERT_TO,
    subject,
    text,
  });
  return true;
}

async function main() {
  const results = [];
  for (const url of URLS) {
    results.push(await checkUrl(url));
  }

  const down = results.filter((r) => !r.ok);
  const currentlyUp = down.length === 0;
  const state = loadState();
  const wasUp = state.up !== false;

  const summary = results
    .map((r) => `${r.ok ? 'OK' : 'DOWN'} ${r.status || '-'} ${r.url}${r.error ? ` (${r.error})` : ''}`)
    .join('\n');

  console.log(new Date().toISOString());
  console.log(summary);

  if (wasUp && !currentlyUp) {
    const body = `Cordfol looks DOWN.\n\n${summary}\n\nTime: ${new Date().toISOString()}\nHost: ${os.hostname()}\n`;
    await sendAlert('[Cordfol] DOWN — check tunnel / app', body);
    saveState({ up: false, since: new Date().toISOString(), lastAlertAt: new Date().toISOString() });
    console.log('[uptime] DOWN alert sent');
    return;
  }

  if (!wasUp && currentlyUp) {
    const body = `Cordfol is back UP.\n\n${summary}\n\nWas down since: ${state.since || 'unknown'}\nRecovered: ${new Date().toISOString()}\n`;
    await sendAlert('[Cordfol] RECOVERED', body);
    saveState({ up: true, since: null, lastAlertAt: new Date().toISOString() });
    console.log('[uptime] RECOVERY alert sent');
    return;
  }

  saveState({ ...state, up: currentlyUp });
}

main().catch((err) => {
  console.error('[uptime] fatal', err);
  process.exit(1);
});
