const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const APPS_ROOT = process.env.APPS_ROOT || path.join(__dirname, 'data', 'hosted-apps');
const TEMPLATE_DIR = path.join(__dirname, 'templates', 'hosted-discord-bot');
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;

function appDir(id) {
  return path.join(APPS_ROOT, id);
}

function logPath(id) {
  return path.join(appDir(id), 'bot.log');
}

function pidPath(id) {
  return path.join(appDir(id), 'bot.pid');
}

function dockerAvailable() {
  return new Promise((resolve) => {
    execFile('docker', ['info'], { timeout: 4000 }, (err) => resolve(!err));
  });
}

function writeEnvFile(dest, token) {
  fs.writeFileSync(path.join(dest, '.env'), `DISCORD_TOKEN=${String(token).replace(/[\r\n]/g, '')}\n`);
}

function writeAppFiles(id, env) {
  const dest = appDir(id);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['package.json', 'index.js']) {
    fs.copyFileSync(path.join(TEMPLATE_DIR, name), path.join(dest, name));
  }
  writeEnvFile(dest, env.DISCORD_TOKEN);
  fs.writeFileSync(path.join(dest, 'config.json'), JSON.stringify({
    prefix: env.BOT_PREFIX,
    status: env.BOT_STATUS,
    commands: JSON.parse(env.COMMANDS_JSON || '[]'),
  }, null, 2));
}

function readPid(id) {
  try {
    const n = Number(fs.readFileSync(pidPath(id), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, windowsHide: true });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out`));
    }, opts.timeout || INSTALL_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
    });
  });
}

async function startDocker(id) {
  const dest = appDir(id);
  await run('docker', ['rm', '-f', `cordfol-app-${id}`], { timeout: 20000 }).catch(() => {});
  await run('docker', [
    'run', '-d',
    '--name', `cordfol-app-${id}`,
    '--restart', 'unless-stopped',
    '--memory', '256m',
    '--cpus', '0.5',
    '--pids-limit', '128',
    '--security-opt', 'no-new-privileges',
    '-w', '/app',
    '-v', `${dest}:/app`,
    '--env-file', path.join(dest, '.env'),
    'node:20-bookworm-slim',
    'sh', '-c', 'npm install --omit=dev --ignore-scripts && node --env-file=.env index.js',
  ], { timeout: 20000 });
  return { runtime: 'docker', containerId: `cordfol-app-${id}` };
}

async function startProcess(id, env) {
  const dest = appDir(id);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await run(npmCmd, ['install', '--omit=dev', '--ignore-scripts'], {
    cwd: dest,
    env: { PATH: process.env.PATH, NODE_ENV: 'production' },
  });

  const log = fs.openSync(logPath(id), 'a');
  const child = spawn(process.execPath, ['--max-old-space-size=192', 'index.js'], {
    cwd: dest,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      DISCORD_TOKEN: env.DISCORD_TOKEN,
      BOT_PREFIX: env.BOT_PREFIX,
      BOT_STATUS: env.BOT_STATUS,
      COMMANDS_JSON: env.COMMANDS_JSON,
    },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(pidPath(id), String(child.pid));
  return { runtime: 'process', pid: child.pid };
}

async function startApp(id, env) {
  writeAppFiles(id, env);
  if (await dockerAvailable()) return startDocker(id);
  return startProcess(id, env);
}

async function stopApp(id, runtime) {
  if (runtime === 'docker' || await dockerAvailable()) {
    await run('docker', ['rm', '-f', `cordfol-app-${id}`], { timeout: 20000 }).catch(() => {});
  }
  const pid = readPid(id);
  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  try { fs.unlinkSync(pidPath(id)); } catch { /* missing */ }
}

function readLogs(id, runtime) {
  return new Promise((resolve) => {
    if (runtime === 'docker') {
      execFile('docker', ['logs', '--tail', '120', `cordfol-app-${id}`], { timeout: 8000 }, (err, stdout, stderr) => {
        resolve(((stdout || '') + (stderr || '')).slice(-8000) || (err ? err.message : 'No logs yet.'));
      });
      return;
    }
    try {
      const text = fs.readFileSync(logPath(id), 'utf8');
      resolve(text.slice(-8000) || 'No logs yet.');
    } catch {
      resolve('No logs yet.');
    }
  });
}

function isRunning(id, runtime, pid) {
  if (runtime === 'process') return isPidAlive(pid || readPid(id));
  return new Promise((resolve) => {
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', `cordfol-app-${id}`], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && String(stdout).trim() === 'true');
    });
  });
}

function removeAppFiles(id) {
  fs.rmSync(appDir(id), { recursive: true, force: true });
}

module.exports = {
  APPS_ROOT,
  startApp,
  stopApp,
  readLogs,
  isRunning,
  removeAppFiles,
  dockerAvailable,
};
