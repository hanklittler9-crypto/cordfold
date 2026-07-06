// ─────────────────────────────────────────────────────────────────────────────
// Spotify OAuth + Now Playing
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const crypto = require('crypto');

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI
  || 'https://api.cordfol.org/api/auth/spotify/callback';
const DASHBOARD_URL = 'https://dashboard.cordfol.org/dashboard.html';

const SCOPES = ['user-read-currently-playing', 'user-read-playback-state'];

function createSpotifyRouter(db) {
  async function getUserTokens(userId) {
    const row = await db.query(`
      SELECT spotify_enabled, spotify_access_token, spotify_refresh_token,
             spotify_token_expires_at, spotify_public
      FROM users WHERE id = $1
    `, [userId]);
    return row.rowCount > 0 ? row.rows[0] : null;
  }

  async function refreshAccessToken(userId, refreshToken) {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: SPOTIFY_CLIENT_ID,
        client_secret: SPOTIFY_CLIENT_SECRET,
      }),
    });

    const data = await tokenRes.json();
    if (!data.access_token) {
      console.error('[spotify] refresh failed:', data);
      throw new Error('Spotify token refresh failed');
    }

    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
    await db.query(`
      UPDATE users SET
        spotify_access_token = $1,
        spotify_refresh_token = COALESCE($2, spotify_refresh_token),
        spotify_token_expires_at = $3
      WHERE id = $4
    `, [data.access_token, data.refresh_token || null, expiresAt, userId]);

    return data.access_token;
  }

  async function getValidAccessToken(userId, forceRefresh = false) {
    const user = await getUserTokens(userId);
    if (!user?.spotify_enabled) return null;
    if (!user.spotify_access_token && !user.spotify_refresh_token) return null;

    const expiresAt = user.spotify_token_expires_at
      ? new Date(user.spotify_token_expires_at)
      : new Date(0);
    const needsRefresh = forceRefresh || expiresAt.getTime() < Date.now() + 60 * 1000;

    if (!needsRefresh && user.spotify_access_token) {
      return user.spotify_access_token;
    }

    if (!user.spotify_refresh_token) {
      return user.spotify_access_token || null;
    }

    try {
      return await refreshAccessToken(userId, user.spotify_refresh_token);
    } catch (err) {
      console.error('[spotify] getValidAccessToken refresh error:', err.message);
      return null;
    }
  }

  async function parseSpotifyError(res) {
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* empty body */
    }
    const message = body?.error?.message || `Spotify API ${res.status}`;
    return { message, status: res.status, body };
  }

  function classifySpotifyError(status, message) {
    const lower = String(message || '').toLowerCase();
    if (status === 403) {
      if (
        lower.includes('not registered') ||
        lower.includes('not approved') ||
        lower.includes('developer dashboard') ||
        lower.includes('user not')
      ) {
        return 'dev_mode';
      }
      if (lower.includes('premium')) return 'premium';
      return 'access_denied';
    }
    if (status === 401) {
      if (lower.includes('scope') || lower.includes('permission') || lower.includes('insufficient')) {
        return 'scope';
      }
      return 'token';
    }
    return 'unknown';
  }

  async function diagnoseSpotify403(accessToken) {
    try {
      const meRes = await fetch('https://api.spotify.com/v1/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (meRes.ok) {
        // Token works for /me but player endpoints fail — usually stale scopes; reconnect fixes it.
        return 'scope';
      }
      const { message } = await parseSpotifyError(meRes);
      console.error('[spotify] /me probe failed:', message);
      return classifySpotifyError(403, message);
    } catch (err) {
      console.error('[spotify] diagnose403 error:', err.message);
      return 'dev_mode';
    }
  }

  function normalizeTrackPayload(data) {
    const item = data?.item;
    if (!item) return { playing: false };

    const artists = (item.artists || []).map(a => a.name).join(', ');
    const albumArt = item.album?.images?.[0]?.url || null;

    return {
      playing: data.is_playing !== false,
      track: {
        name: item.name,
        artist: artists,
        album: item.album?.name || '',
        albumArt,
        url: item.external_urls?.spotify || null,
        progressMs: data.progress_ms || 0,
        durationMs: item.duration_ms || 0,
      },
    };
  }

  async function fetchPlayerEndpoint(accessToken, url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 204 || res.status === 202) {
      return { playing: false };
    }
    if (!res.ok) {
      const { message, body } = await parseSpotifyError(res);
      console.error('[spotify] player API error:', res.status, message, body?.error || '');
      const err = new Error(message);
      err.status = res.status;
      err.reason = classifySpotifyError(res.status, message);
      throw err;
    }

    const data = await res.json();
    return normalizeTrackPayload(data);
  }

  async function fetchCurrentlyPlaying(accessToken) {
    const endpoints = [
      'https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode',
      'https://api.spotify.com/v1/me/player?additional_types=track,episode',
    ];

    let lastErr;
    for (const url of endpoints) {
      try {
        return await fetchPlayerEndpoint(accessToken, url);
      } catch (err) {
        lastErr = err;
        if (err.status === 403 && !err.reason) {
          err.reason = await diagnoseSpotify403(accessToken);
        }
        if (err.reason === 'dev_mode' || err.reason === 'premium') throw err;
      }
    }
    throw lastErr || new Error('Spotify playback unavailable');
  }

  async function fetchCurrentlyPlayingForUser(userId) {
    let accessToken = await getValidAccessToken(userId);
    if (!accessToken) return null;

    try {
      return await fetchCurrentlyPlaying(accessToken);
    } catch (err) {
      if (err.status !== 401 && err.status !== 403) throw err;
      accessToken = await getValidAccessToken(userId, true);
      if (!accessToken) throw err;
      try {
        return await fetchCurrentlyPlaying(accessToken);
      } catch (retryErr) {
        if (retryErr.status === 403 && !retryErr.reason) {
          retryErr.reason = await diagnoseSpotify403(accessToken);
        }
        throw retryErr;
      }
    }
  }

  async function getNowPlayingForUser(userId) {
    const user = await getUserTokens(userId);
    if (!user?.spotify_enabled || !user.spotify_public) {
      return null;
    }

    try {
      const result = await fetchCurrentlyPlayingForUser(userId);
      if (!result) {
        return { playing: false, connected: true, tokenError: true, errorReason: 'token' };
      }
      return { ...result, connected: true };
    } catch (err) {
      console.error('[spotify] now playing error:', err.message);
      return {
        playing: false,
        connected: true,
        tokenError: true,
        errorReason: err.reason || classifySpotifyError(err.status, err.message),
        errorMessage: err.message,
      };
    }
  }

  const authRouter = express.Router();
  const apiRouter = express.Router();

  const oauthCookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 10 * 60 * 1000,
    path: '/',
  };

  async function restoreSessionFromSid(req, sid) {
    if (req.session?.userId) return true;
    if (!sid) return false;
    try {
      const result = await db.query('SELECT sess FROM user_sessions WHERE sid = $1', [sid]);
      if (result.rowCount > 0 && result.rows[0].sess?.userId) {
        req.session.userId = result.rows[0].sess.userId;
        return true;
      }
    } catch (err) {
      console.error('[spotify] session restore error:', err.message);
    }
    return false;
  }

  /** Auth via cookie session or ?sid= without touching express-session (avoids cookie churn). */
  async function getAuthedUserId(req) {
    if (req.session?.userId) return req.session.userId;
    const sid = req.query.sid;
    if (!sid) return null;
    try {
      const result = await db.query('SELECT sess FROM user_sessions WHERE sid = $1', [sid]);
      if (result.rowCount > 0 && result.rows[0].sess?.userId) {
        return result.rows[0].sess.userId;
      }
    } catch (err) {
      console.error('[spotify] sid auth error:', err.message);
    }
    return null;
  }

  authRouter.get('/login', async (req, res) => {
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      return res.status(503).send('Spotify is not configured on this server.');
    }

    if (!req.session?.userId) {
      await restoreSessionFromSid(req, req.query.sid);
    }

    const userId = req.session?.userId || await getAuthedUserId(req);
    if (!userId) {
      const sid = req.query.sid || '';
      const qs = sid
        ? `?spotify=login_required&sid=${encodeURIComponent(sid)}`
        : '?spotify=login_required';
      return res.redirect(`${DASHBOARD_URL}${qs}`);
    }

    if (!req.session.userId) {
      req.session.userId = userId;
    }

    // Keep the dashboard sid so callback can restore the same Discord session row.
    const oauthSid = req.query.sid || req.sessionID;

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('spotify_oauth_state', state, oauthCookieOpts);
    res.cookie('spotify_oauth_sid', oauthSid, oauthCookieOpts);

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.set('client_id', SPOTIFY_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', SPOTIFY_REDIRECT_URI);
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('show_dialog', 'true');

    req.session.save((err) => {
      if (err) {
        console.error('[spotify] session save before redirect:', err);
        return res.redirect(`${DASHBOARD_URL}?spotify=failed`);
      }
      res.redirect(authUrl.toString());
    });
  });

  authRouter.get('/callback', async (req, res) => {
    const { code, error, state } = req.query;

    if (error) {
      return res.redirect(`${DASHBOARD_URL}?spotify=denied`);
    }

    const savedState = req.cookies?.spotify_oauth_state;
    const savedSid = req.cookies?.spotify_oauth_sid;
    res.clearCookie('spotify_oauth_state', { path: '/' });
    res.clearCookie('spotify_oauth_sid', { path: '/' });

    if (!state || !savedState || state !== savedState) {
      console.error('[spotify] CSRF state mismatch');
      return res.redirect(`${DASHBOARD_URL}?spotify=csrf`);
    }

    if (!code) {
      return res.redirect(`${DASHBOARD_URL}?spotify=no_code`);
    }

    await restoreSessionFromSid(req, savedSid);

    const userId = req.session?.userId;
    if (!userId) {
      console.error('[spotify] No session on callback');
      return res.redirect(`${DASHBOARD_URL}?spotify=login_required`);
    }

    try {
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: SPOTIFY_REDIRECT_URI,
          client_id: SPOTIFY_CLIENT_ID,
          client_secret: SPOTIFY_CLIENT_SECRET,
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        console.error('[spotify] token exchange failed:', tokenData);
        throw new Error(tokenData.error_description || tokenData.error || 'No access token');
      }

      if (!tokenData.refresh_token) {
        console.warn('[spotify] No refresh_token returned — reconnect may fail later');
      }

      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);

      await db.query(`
        UPDATE users SET
          spotify_enabled = true,
          spotify_public = true,
          spotify_access_token = $1,
          spotify_refresh_token = $2,
          spotify_token_expires_at = $3,
          updated_at = NOW()
        WHERE id = $4
      `, [
        tokenData.access_token,
        tokenData.refresh_token || null,
        expiresAt,
        userId,
      ]);

      // Verify the new token can reach Spotify before declaring success.
      try {
        await fetchCurrentlyPlaying(tokenData.access_token);
      } catch (verifyErr) {
        let reason = verifyErr.reason;
        if (verifyErr.status === 403) {
          reason = await diagnoseSpotify403(tokenData.access_token);
        }
        console.error('[spotify] post-connect verify failed:', verifyErr.message, 'reason:', reason);
        const sid = savedSid || req.sessionID || '';
        const qs = new URLSearchParams({
          spotify: 'access_denied',
          reason: reason || 'unknown',
          ...(sid ? { sid } : {}),
        });
        return res.redirect(`${DASHBOARD_URL}?${qs.toString()}`);
      }

      req.session.save((err) => {
        if (err) console.error('[spotify] session save after connect:', err);
        const sid = savedSid || req.sessionID || '';
        const qs = sid ? `?spotify=connected&sid=${encodeURIComponent(sid)}` : '?spotify=connected';
        res.redirect(`${DASHBOARD_URL}${qs}`);
      });
    } catch (err) {
      console.error('[spotify] Callback error:', err);
      res.redirect(`${DASHBOARD_URL}?spotify=failed`);
    }
  });

  apiRouter.get('/status', async (req, res) => {
    try {
      const userId = await getAuthedUserId(req);
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const user = await getUserTokens(userId);
      if (!user?.spotify_enabled) {
        return res.json({ connected: false, public: false, nowPlaying: null });
      }

      let nowPlaying = { playing: false };
      let tokenError = false;
      let errorReason = null;
      let errorMessage = null;
      try {
        const result = await fetchCurrentlyPlayingForUser(userId);
        if (result) nowPlaying = result;
        else {
          tokenError = true;
          errorReason = 'token';
        }
      } catch (err) {
        tokenError = true;
        errorReason = err.reason || classifySpotifyError(err.status, err.message);
        errorMessage = err.message;
        console.error('[spotify] status playback error:', err.message, 'reason:', errorReason);
      }

      res.json({
        connected: true,
        public: user.spotify_public !== false,
        nowPlaying,
        tokenError,
        errorReason,
        errorMessage,
      });
    } catch (err) {
      console.error('[spotify] status error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  apiRouter.post('/disconnect', async (req, res) => {
    try {
      const userId = await getAuthedUserId(req);
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      await db.query(`
        UPDATE users SET
          spotify_enabled = false,
          spotify_public = false,
          spotify_access_token = NULL,
          spotify_refresh_token = NULL,
          spotify_token_expires_at = NULL
        WHERE id = $1
      `, [userId]);

      res.json({ ok: true });
    } catch (err) {
      console.error('[spotify] disconnect error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  apiRouter.post('/settings', async (req, res) => {
    try {
      const userId = await getAuthedUserId(req);
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { isPublic } = req.body;
      await db.query(
        'UPDATE users SET spotify_public = $1 WHERE id = $2 AND spotify_enabled = true',
        [!!isPublic, userId]
      );

      res.json({ ok: true, public: !!isPublic });
    } catch (err) {
      console.error('[spotify] settings error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return { authRouter, apiRouter, getNowPlayingForUser };
}

module.exports = createSpotifyRouter;
