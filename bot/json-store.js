// Simple JSON file store under bot/data/
const fs = require('fs');
const path = require('path');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    ensureDir(filePath);
    if (!fs.existsSync(filePath)) {
      return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
  }
}

function writeJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { readJson, writeJson, ensureDir };
