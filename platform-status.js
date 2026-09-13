// Shared live status snapshot for /status and the Discord bot.

const os = require('os');
const statusStore = require('./bot/status-store');
const { ollamaStatus, OLLAMA_MODEL } = require('./ai-builder');

const SEP11_DATE = '2026-09-11';
const SEP11_TITLE = 'Major update outage';
const SEP11_MESSAGE =
  'Cordfol was online on September 11, but our server went down due to a major update, leaving us with a temporary outage. We\'re still working on getting everything back up to speed.';

const INCIDENT_QUESTION = /\b(september\s*11|sep\.?\s*11|sept\.?\s*11)\b|\bwhat happened\b.{0,40}\b(cordfol|site|server|down|outage)\b|\b(was (it|the site|cordfol) down|went down|temporary outage|why.{0,24}(down|outage))\b/i;

const STATE_RANK = {
  operational: 0,
  up: 0,
  degraded: 1,
  recovering: 1,
  maintenance: 2,
  down: 3,
};

const COMPONENT_DEFS = [
  { id: 'edge', name: 'Website / Edge', hint: 'cordfol.org over Cloudflare Tunnel' },
  { id: 'api', name: 'API', hint: 'Profiles, dashboard, OAuth' },
  { id: 'database', name: 'Postgres', hint: 'Identities and sessions' },
  { id: 'auth', name: 'Discord Auth', hint: 'Sign-in + role sync' },
  { id: 'bot', name: 'Discord Bot', hint: 'Verify, Pro, mentions' },
  { id: 'ai', name: 'AI Builder', hint: `Ollama · ${OLLAMA_MODEL}` },
  { id: 'apps', name: 'Hosted Apps', hint: 'User bots on this box' },
];

let cpuPrev = null;
let cached = null;
let cachedAt = 0;
const CACHE_MS = 4000;

function isIncidentQuestion(text) {
  return INCIDENT_QUESTION.test(String(text || ''));
}

function takeCpuSample() {
  return os.cpus().map((c) => {
    const t = c.times;
    return {
      model: c.model,
      speed: c.speed,
      idle: t.idle,
      total: t.user + t.nice + t.sys + t.idle + t.irq,
    };
  });
}

function coresFrom(prev, next) {
  return next.map((n, i) => {
    const p = prev[i] || n;
    const dt = Math.max(1, n.total - p.total);
    const di = Math.max(0, n.idle - p.idle);
    const usage = Math.min(100, Math.max(0, (1 - di / dt) * 100));
    return {
      id: i,
      label: `CPU ${i}`,
      model: n.model.replace(/\s+/g, ' ').trim(),
      mhz: n.speed,
      usage: Math.round(usage * 10) / 10,
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sampleCores() {
  const next = takeCpuSample();
  if (!cpuPrev) {
    await sleep(220);
    const second = takeCpuSample();
    cpuPrev = second;
    return coresFrom(next, second);
  }
  const cores = coresFrom(cpuPrev, next);
  cpuPrev = next;
  return cores;
}

function utcDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function dayState(dateKey) {
  if (dateKey === SEP11_DATE) return 'down';
  if (dateKey === '2026-09-12') return 'degraded';
  return 'operational';
}

function buildCalendar(days = 90) {
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const date = utcDay(d);
    out.push({ date, state: dayState(date) });
  }
  return out;
}

function uptimeFromCalendar(calendar) {
  if (!calendar.length) return 100;
  const score = calendar.reduce((sum, day) => {
    if (day.state === 'down') return sum;
    if (day.state === 'degraded') return sum + 0.5;
    return sum + 1;
  }, 0);
  return Math.round((score / calendar.length) * 1000) / 10;
}

function worse(a, b) {
  return (STATE_RANK[a] || 0) >= (STATE_RANK[b] || 0) ? a : b;
}

function mapDeclared(state) {
  if (state === 'up') return 'operational';
  if (state === 'down') return 'down';
  if (state === 'maintenance') return 'maintenance';
  return 'degraded';
}

function hostLabel() {
  if (process.env.STATUS_HOST_NAME) return process.env.STATUS_HOST_NAME;
  return process.platform === 'linux' ? os.hostname() : 'astroserver';
}

function formatBytes(n) {
  const gb = n / (1024 ** 3);
  return Math.round(gb * 10) / 10;
}

async function probeDb(db) {
  const t0 = Date.now();
  try {
    await db.query('SELECT 1');
    return { ok: true, ms: Date.now() - t0 };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  }
}

async function countSafe(db, sql) {
  try {
    const row = await db.query(sql);
    return Number(row.rows[0]?.n || 0);
  } catch {
    return null;
  }
}

function incidents() {
  return [
    {
      id: 'inc-2026-09-11',
      startedAt: '2026-09-11T00:00:00.000Z',
      resolvedAt: '2026-09-13T16:00:00.000Z',
      impact: 'major',
      status: 'resolved',
      title: SEP11_TITLE,
      body: SEP11_MESSAGE,
      components: ['Website / Edge', 'API', 'Postgres', 'Discord Bot'],
    },
  ];
}

async function collectPlatformStatus({ db, botClient } = {}) {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;

  const declared = statusStore.readStatus();
  const cores = await sampleCores();
  const [dbProbe, ai, identities, runningApps] = await Promise.all([
    db ? probeDb(db) : Promise.resolve({ ok: false, ms: 0 }),
    ollamaStatus(),
    db ? countSafe(db, 'SELECT COUNT(*)::int AS n FROM users') : Promise.resolve(null),
    db ? countSafe(db, "SELECT COUNT(*)::int AS n FROM hosted_apps WHERE status IN ('running','online','active')") : Promise.resolve(null),
  ]);

  const botOnline = !!(botClient && botClient.user);
  const load = os.loadavg().map((n) => Math.round(n * 100) / 100);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = Math.round((usedMem / totalMem) * 1000) / 10;
  const cpuAvg = cores.length
    ? Math.round((cores.reduce((s, c) => s + c.usage, 0) / cores.length) * 10) / 10
    : 0;

  const live = {
    edge: 'operational',
    api: 'operational',
    database: dbProbe.ok ? 'operational' : 'down',
    auth: 'operational',
    bot: botOnline ? 'operational' : 'degraded',
    ai: ai.available ? 'operational' : 'degraded',
    apps: 'operational',
  };

  const openIncident = incidents().some((i) => !i.resolvedAt);
  let overall = mapDeclared(declared.state);
  for (const state of Object.values(live)) overall = worse(overall, state);
  if (openIncident && overall === 'operational') overall = 'recovering';

  const calendar = buildCalendar(90);
  const components = COMPONENT_DEFS.map((def) => {
    const state = live[def.id] || 'operational';
    let message = 'Operating normally.';
    if (def.id === 'database') message = dbProbe.ok ? `Responding in ${dbProbe.ms}ms.` : 'Database probe failed.';
    if (def.id === 'bot') {
      message = botOnline
        ? `Online as ${botClient.user.tag} · ${botClient.ws?.ping || 0}ms gateway.`
        : 'Bot process is not connected.';
    }
    if (def.id === 'ai') {
      message = ai.available
        ? `${ai.model} is ready${ai.models?.length ? ` · ${ai.models.length} models` : ''}.`
        : 'Ollama is offline — builder falls back to heuristics.';
    }
    if (def.id === 'apps') {
      message = runningApps == null
        ? 'Hosted apps runner is attached to this process.'
        : `${runningApps} app${runningApps === 1 ? '' : 's'} running.`;
    }
    if (def.id === 'edge') message = 'Served through Cloudflare Tunnel.';
    if (openIncident && ['edge', 'api', 'database', 'bot'].includes(def.id) && state === 'operational') {
      message = `${message} Recovering from the September 11 update.`;
    }
    return { ...def, state, message };
  });

  cached = {
    overall,
    message: openIncident ? SEP11_MESSAGE : (declared.message || 'All systems operational.'),
    declared: {
      state: declared.state,
      message: declared.message,
      updatedAt: declared.updatedAt,
      updatedBy: declared.updatedBy,
    },
    uptime: {
      percent: uptimeFromCalendar(calendar),
      windowDays: 90,
      calendar,
    },
    host: {
      name: hostLabel(),
      platform: process.platform,
      arch: os.arch(),
      cores: cores.length,
      model: cores[0]?.model || 'CPU',
      cpuAvg,
      load,
      memory: {
        usedGb: formatBytes(usedMem),
        totalGb: formatBytes(totalMem),
        percent: memPct,
      },
      process: {
        rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        uptimeSec: Math.round(process.uptime()),
      },
      systemUptimeSec: Math.round(os.uptime()),
    },
    cores,
    components,
    incidents: incidents(),
    counts: {
      identities,
      runningApps,
      guilds: botClient?.guilds?.cache?.size || 0,
    },
    probes: {
      databaseMs: dbProbe.ms,
      botPing: botClient?.ws?.ping || null,
      ollama: !!ai.available,
    },
    generatedAt: new Date().toISOString(),
  };
  cachedAt = now;
  return cached;
}

module.exports = {
  SEP11_DATE,
  SEP11_TITLE,
  SEP11_MESSAGE,
  isIncidentQuestion,
  collectPlatformStatus,
};
