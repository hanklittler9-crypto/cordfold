const express = require('express');
const crypto = require('crypto');
const runner = require('./hosted-apps-runner');

const MAX_APPS = Number(process.env.APPS_MAX_PER_USER || 3);
const ALLOWED_IDS = String(process.env.APPS_ALLOWED_DISCORD_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function encrypt(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32-byte hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
  const [ivHex, tagHex, dataHex] = String(stored || '').split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(dataHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'bot';
}

function sanitizeCommands(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.name === 'string' && typeof c.reply === 'string')
    .slice(0, 25)
    .map((c) => ({
      name: c.name.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24),
      reply: String(c.reply).slice(0, 1800),
    }))
    .filter((c) => c.name && c.reply);
}

function publicApp(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    prefix: row.prefix,
    statusText: row.status_text,
    commands: row.commands || [],
    tokenSet: Boolean(row.token_enc),
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createHostedAppsRouter(db) {
  const router = express.Router();

  async function resolveUser(req) {
    let userId = req.session?.userId || null;
    const { sid } = req.query;
    if (!userId && sid) {
      const result = await db.query('SELECT sess FROM user_sessions WHERE sid = $1', [sid]);
      const sess = result.rows[0]?.sess;
      const parsed = typeof sess === 'string' ? JSON.parse(sess) : sess;
      userId = parsed?.userId || null;
    }
    if (!userId) return null;
    const row = await db.query(
      'SELECT id, discord_id, discord_username FROM users WHERE id = $1',
      [userId]
    );
    return row.rows[0] || null;
  }

  function canDeploy(user) {
    if (!ALLOWED_IDS.length) return true;
    return ALLOWED_IDS.includes(String(user.discord_id));
  }

  router.use(async (req, res, next) => {
    try {
      const user = await resolveUser(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      if (!canDeploy(user)) {
        return res.status(403).json({ error: 'Hosting is invite-only right now.' });
      }
      req.appUser = user;
      next();
    } catch (err) {
      console.error('[apps] auth error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const result = await db.query(
        'SELECT * FROM hosted_apps WHERE user_id = $1 ORDER BY created_at DESC',
        [req.appUser.id]
      );
      const apps = [];
      for (const row of result.rows) {
        if (row.status === 'running') {
          const live = await runner.isRunning(row.id, row.runtime, row.pid);
          if (!live) {
            await db.query(
              `UPDATE hosted_apps SET status = 'stopped', updated_at = NOW() WHERE id = $1`,
              [row.id]
            );
            row.status = 'stopped';
          }
        }
        apps.push(publicApp(row));
      }
      res.json({
        apps,
        max: MAX_APPS,
        docker: await runner.dockerAvailable(),
        offWifi: true,
      });
    } catch (err) {
      console.error('[apps] list error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 40);
      if (name.length < 2) return res.status(400).json({ error: 'Name needs at least 2 characters.' });

      const count = await db.query('SELECT COUNT(*)::int AS n FROM hosted_apps WHERE user_id = $1', [req.appUser.id]);
      if (count.rows[0].n >= MAX_APPS) {
        return res.status(400).json({ error: `You can host ${MAX_APPS} apps on this server.` });
      }

      const id = crypto.randomBytes(8).toString('hex');
      const slug = `${slugify(name)}-${id.slice(0, 4)}`;
      const prefix = String(req.body?.prefix || '!').slice(0, 8) || '!';
      const statusText = String(req.body?.statusText || '').slice(0, 80);
      const commands = sanitizeCommands(req.body?.commands);
      let tokenEnc = null;
      if (req.body?.token) tokenEnc = encrypt(String(req.body.token).trim());

      const inserted = await db.query(
        `INSERT INTO hosted_apps
          (id, user_id, name, slug, prefix, status_text, commands, token_enc, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'stopped')
         RETURNING *`,
        [id, req.appUser.id, name, slug, prefix, statusText, JSON.stringify(commands), tokenEnc]
      );
      res.status(201).json({ app: publicApp(inserted.rows[0]) });
    } catch (err) {
      console.error('[apps] create error:', err);
      res.status(500).json({ error: 'Could not create app.' });
    }
  });

  async function loadOwned(req, res) {
    const result = await db.query(
      'SELECT * FROM hosted_apps WHERE id = $1 AND user_id = $2',
      [req.params.id, req.appUser.id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'App not found.' });
      return null;
    }
    return result.rows[0];
  }

  router.patch('/:id', async (req, res) => {
    try {
      const row = await loadOwned(req, res);
      if (!row) return;

      const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 40) : row.name;
      const prefix = req.body?.prefix != null ? String(req.body.prefix).slice(0, 8) || '!' : row.prefix;
      const statusText = req.body?.statusText != null ? String(req.body.statusText).slice(0, 80) : row.status_text;
      const commands = req.body?.commands != null ? sanitizeCommands(req.body.commands) : row.commands;
      let tokenEnc = row.token_enc;
      if (req.body?.token) tokenEnc = encrypt(String(req.body.token).trim());

      const updated = await db.query(
        `UPDATE hosted_apps
         SET name = $1, prefix = $2, status_text = $3, commands = $4::jsonb, token_enc = $5, updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [name, prefix, statusText, JSON.stringify(commands), tokenEnc, row.id]
      );
      res.json({ app: publicApp(updated.rows[0]) });
    } catch (err) {
      console.error('[apps] update error:', err);
      res.status(500).json({ error: 'Could not save app.' });
    }
  });

  router.post('/:id/start', async (req, res) => {
    try {
      const row = await loadOwned(req, res);
      if (!row) return;
      if (!row.token_enc) return res.status(400).json({ error: 'Add a Discord bot token first.' });

      await db.query(`UPDATE hosted_apps SET status = 'starting', last_error = NULL, updated_at = NOW() WHERE id = $1`, [row.id]);
      const env = {
        DISCORD_TOKEN: decrypt(row.token_enc),
        BOT_PREFIX: row.prefix || '!',
        BOT_STATUS: row.status_text || '',
        COMMANDS_JSON: JSON.stringify(row.commands || []),
      };
      const started = await runner.startApp(row.id, env);
      const updated = await db.query(
        `UPDATE hosted_apps
         SET status = 'running', runtime = $1, container_id = $2, pid = $3, last_error = NULL, updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [started.runtime, started.containerId || null, started.pid || null, row.id]
      );
      res.json({ app: publicApp(updated.rows[0]) });
    } catch (err) {
      console.error('[apps] start error:', err);
      await db.query(
        `UPDATE hosted_apps SET status = 'error', last_error = $1, updated_at = NOW() WHERE id = $2`,
        [String(err.message || 'Start failed').slice(0, 400), req.params.id]
      ).catch(() => {});
      res.status(500).json({ error: err.message || 'Could not start app.' });
    }
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      const row = await loadOwned(req, res);
      if (!row) return;
      await runner.stopApp(row.id, row.runtime);
      const updated = await db.query(
        `UPDATE hosted_apps SET status = 'stopped', pid = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [row.id]
      );
      res.json({ app: publicApp(updated.rows[0]) });
    } catch (err) {
      console.error('[apps] stop error:', err);
      res.status(500).json({ error: 'Could not stop app.' });
    }
  });

  router.get('/:id/logs', async (req, res) => {
    try {
      const row = await loadOwned(req, res);
      if (!row) return;
      const logs = await runner.readLogs(row.id, row.runtime);
      res.json({ logs });
    } catch (err) {
      console.error('[apps] logs error:', err);
      res.status(500).json({ error: 'Could not read logs.' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const row = await loadOwned(req, res);
      if (!row) return;
      await runner.stopApp(row.id, row.runtime).catch(() => {});
      runner.removeAppFiles(row.id);
      await db.query('DELETE FROM hosted_apps WHERE id = $1', [row.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('[apps] delete error:', err);
      res.status(500).json({ error: 'Could not delete app.' });
    }
  });

  return router;
}

module.exports = createHostedAppsRouter;
