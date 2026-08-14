// ─────────────────────────────────────────────────────────────────────────────
// Cordfol site status persistence (file-backed)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const STATUS_FILE = path.join(__dirname, 'data', 'site-status.json');

const VALID_STATES = new Set(['up', 'down', 'degraded', 'maintenance']);

const DEFAULT_STATUS = {
  state: 'up',
  message: 'All systems operational.',
  updatedAt: null,
  updatedBy: null,
  updatedById: null,
};

function ensureDir() {
  const dir = path.dirname(STATUS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readStatus() {
  try {
    ensureDir();
    if (!fs.existsSync(STATUS_FILE)) return { ...DEFAULT_STATUS };
    const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    const state = VALID_STATES.has(raw.state) ? raw.state : 'up';
    return {
      state,
      message: typeof raw.message === 'string' && raw.message.trim()
        ? raw.message.trim().slice(0, 1000)
        : DEFAULT_STATUS.message,
      updatedAt: raw.updatedAt || null,
      updatedBy: raw.updatedBy || null,
      updatedById: raw.updatedById || null,
    };
  } catch {
    return { ...DEFAULT_STATUS };
  }
}

function writeStatus({ state, message, updatedBy, updatedById }) {
  if (!VALID_STATES.has(state)) {
    throw new Error(`Invalid status state: ${state}`);
  }
  ensureDir();
  const next = {
    state,
    message: (message || DEFAULT_STATUS.message).trim().slice(0, 1000),
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || null,
    updatedById: updatedById || null,
  };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  VALID_STATES,
  DEFAULT_STATUS,
  readStatus,
  writeStatus,
};
