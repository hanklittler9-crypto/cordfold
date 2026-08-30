#!/usr/bin/env node
/**
 * Restart cloudflared when the app is up locally but the public tunnel is dead.
 * Cron every minute on astroserver:
 *   * * * * * /usr/bin/node /home/gfxastro/CordFold/scripts/tunnel-watchdog.js >> /tmp/cordfol-tunnel.log 2>&1
 */
require('dotenv').config({ path: require('path').join(require('os').homedir(), '.env') });
require('dotenv').config();

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCAL_URL = process.env.TUNNEL_LOCAL_URL || 'http://127.0.0.1:3000/';
const PUBLIC_URLS = (process.env.TUNNEL_PUBLIC_URLS || 'https://cordfol.org/,https://api.cordfol.org/api/auth/me')
  .split(',').map((s) => s.trim()).filter(Boolean);
const STATE_FILE = process.env.TUNNEL_STATE_FILE || path.join(os.homedir(), '.cordfol-tunnel-state.json');
const FAIL_STREAK = Number(process.env.TUNNEL_FAIL_STREAK || 2);
const SERVICE = process.env.TUNNEL_SERVICE || 'cloudflared';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { publicFails: 0, lastRestartAt: 0 }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'cordfol-tunnel-watchdog/1.0' },
    });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function restartTunnel() {
  return new Promise((resolve) => {
    execFile('systemctl', ['restart', SERVICE], { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, detail: (stderr || stdout || err?.message || 'restarted').toString().trim() });
    });
  });
}

async function main() {
  const localOk = await probe(LOCAL_URL);
  const publicResults = await Promise.all(PUBLIC_URLS.map(async (url) => ({ url, ok: await probe(url) })));
  const publicOk = publicResults.some((r) => r.ok);
  const state = loadState();

  console.log(`[tunnel] local=${localOk} public=${publicOk} fails=${state.publicFails} ${publicResults.map((r) => `${r.url}:${r.ok}`).join(' ')}`);

  if (!localOk) {
    state.publicFails = 0;
    saveState(state);
    return;
  }

  if (publicOk) {
    state.publicFails = 0;
    saveState(state);
    return;
  }

  state.publicFails = Number(state.publicFails || 0) + 1;
  const now = Date.now();
  const cooled = now - Number(state.lastRestartAt || 0) > 90 * 1000;
  if (state.publicFails >= FAIL_STREAK && cooled) {
    const result = await restartTunnel();
    state.lastRestartAt = now;
    state.publicFails = 0;
    console.log(`[tunnel] restarted ${SERVICE}: ${result.ok} ${result.detail}`);
  }
  saveState(state);
}

main().catch((err) => {
  console.error('[tunnel] watchdog error:', err.message);
  process.exit(1);
});
