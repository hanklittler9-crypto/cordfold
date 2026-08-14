// Shared Postgres pool — SSL only for remote hosts (Neon etc.), never force SSL on localhost.
const { Pool } = require('pg');

function needsSsl(connectionString) {
  if (process.env.DATABASE_SSL === 'true') return true;
  if (process.env.DATABASE_SSL === 'false') return false;
  const url = connectionString || '';
  if (/sslmode=require/i.test(url)) return true;
  if (/\.neon\.tech/i.test(url)) return true;
  if (/@(localhost|127\.0\.0\.1)(:|\/)/i.test(url)) return false;
  return false;
}

function createPool(connectionString, extra = {}) {
  const config = {
    connectionString,
    max: extra.max ?? 10,
    ...extra,
  };
  if (needsSsl(connectionString)) {
    config.ssl = { rejectUnauthorized: false };
  } else {
    delete config.ssl;
  }

  const pool = new Pool(config);
  // Unhandled pool errors crash Node — always attach a listener.
  pool.on('error', (err) => {
    console.error('[db] Idle client error (non-fatal):', err.message);
  });
  return pool;
}

module.exports = { createPool, needsSsl };
