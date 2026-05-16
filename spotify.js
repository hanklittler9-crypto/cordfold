// ─────────────────────────────────────────────────────────────────────────────
// Spotify OAuth Integration
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const router = express.Router();

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://dashboard.cordfol.org/auth/spotify/callback';

// ── Login with Spotify ────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  const scopes = ['user-read-currently-playing', 'user-read-playback-state'];
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.append('client_id', SPOTIFY_CLIENT_ID);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('redirect_uri', SPOTIFY_REDIRECT_URI);
  authUrl.searchParams.append('scope', scopes.join(' '));
  res.redirect(authUrl.toString());
});

// ── Spotify Callback ──────────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`/?error=spotify_${error}`);
  }

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Exchange code for tokens
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
      throw new Error('No access token');
    }

    // Get user ID from session
    const userId = req.session?.userId;
    if (!userId) {
      return res.redirect('/?error=not_authenticated');
    }

    // Store tokens in database
    await db.query(`
      UPDATE users SET
        spotify_enabled = true,
        spotify_access_token = $1,
        spotify_refresh_token = $2,
        spotify_token_expires_at = NOW() + INTERVAL '1 hour'
      WHERE id = $3
    `, [tokenData.access_token, tokenData.refresh_token, userId]);

    res.redirect('/dashboard?spotify=connected');
  } catch (err) {
    console.error('[spotify] Callback error:', err);
    res.redirect('/?error=spotify_auth_failed');
  }
});

// ── Disconnect Spotify ────────────────────────────────────────────────────────
router.post('/disconnect', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    await db.query(`
      UPDATE users SET
        spotify_enabled = false,
        spotify_access_token = NULL,
        spotify_refresh_token = NULL,
        spotify_token_expires_at = NULL
      WHERE id = $1
    `, [userId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[spotify] Disconnect error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
