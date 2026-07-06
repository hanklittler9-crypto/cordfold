// ─────────────────────────────────────────────────────────────────────────────
// Dynamic OG image cards — rendered profile preview for Discord/Twitter embeds.
// GET /og/:slug.png → 1200x630 PNG built from an SVG template via sharp.
// ─────────────────────────────────────────────────────────────────────────────

const sharp = require('sharp');

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map(); // slug -> { buffer, expires }

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1).trimEnd() + '…' : str;
}

function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

async function fetchAvatarBase64(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Normalize to PNG so librsvg can always embed it
    const png = await sharp(buf).resize(220, 220).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

function buildSvg({ name, bio, slug, accent, avatarData, roleCount, viewCount }) {
  const initial = esc((name[0] || '?').toUpperCase());
  const safeAccent = /^#[0-9a-fA-F]{6}$/.test(accent || '') ? accent : '#5865F2';

  const avatar = avatarData
    ? `<image href="${avatarData}" x="80" y="205" width="220" height="220" clip-path="url(#avClip)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="190" cy="315" r="110" fill="${safeAccent}"/>
       <text x="190" y="352" font-family="DejaVu Sans, Arial, sans-serif" font-size="96" font-weight="700" fill="#ffffff" text-anchor="middle">${initial}</text>`;

  const chips = [];
  if (viewCount > 0) chips.push(`${formatCount(viewCount)} views`);
  if (roleCount > 0) chips.push(`${roleCount} verified role${roleCount === 1 ? '' : 's'}`);
  chips.push('Verified Discord profile');

  let chipX = 360;
  const chipsSvg = chips.map(label => {
    const w = label.length * 11.5 + 44;
    const el = `
      <rect x="${chipX}" y="420" rx="19" ry="19" width="${w}" height="38" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>
      <text x="${chipX + w / 2}" y="445" font-family="DejaVu Sans, Arial, sans-serif" font-size="19" fill="rgba(255,255,255,0.75)" text-anchor="middle">${esc(label)}</text>`;
    chipX += w + 14;
    return el;
  }).join('');

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <clipPath id="avClip"><circle cx="190" cy="315" r="110"/></clipPath>
    <radialGradient id="glow1" cx="15%" cy="10%" r="60%">
      <stop offset="0%" stop-color="${safeAccent}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${safeAccent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="90%" cy="95%" r="55%">
      <stop offset="0%" stop-color="${safeAccent}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${safeAccent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="#09090d"/>
  <rect width="1200" height="630" fill="url(#glow1)"/>
  <rect width="1200" height="630" fill="url(#glow2)"/>
  <rect x="24" y="24" width="1152" height="582" rx="28" fill="rgba(17,19,26,0.72)" stroke="rgba(255,255,255,0.09)" stroke-width="1.5"/>

  <circle cx="190" cy="315" r="116" fill="none" stroke="${safeAccent}" stroke-width="5"/>
  ${avatar}

  <text x="360" y="250" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" letter-spacing="4" fill="rgba(255,255,255,0.45)">CORDFOL.ORG/${esc(slug.toUpperCase())}</text>
  <text x="360" y="330" font-family="DejaVu Sans, Arial, sans-serif" font-size="64" font-weight="700" fill="#f5f7fb">${esc(truncate(name, 22))}</text>
  <text x="360" y="385" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" fill="rgba(255,255,255,0.6)">${esc(truncate(bio, 70))}</text>

  ${chipsSvg}

  <text x="1152" y="580" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" font-weight="700" fill="rgba(255,255,255,0.35)" text-anchor="end">CORDFOL</text>
</svg>`;
}

function createOgRoute(db) {
  return async function ogHandler(req, res) {
    const slug = String(req.params.slug || '').toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 64);
    if (!slug) return res.status(404).send('Not found');

    const cached = cache.get(slug);
    if (cached && cached.expires > Date.now()) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=600');
      return res.send(cached.buffer);
    }

    try {
      const row = await db.query(`
        SELECT u.id, u.discord_id, u.discord_username, u.display_name, u.bio,
               u.avatar_hash, u.avatar_url,
               t.accent_color
        FROM users u
        LEFT JOIN themes t ON t.id = u.theme_id
        WHERE u.slug = $1
      `, [slug]);

      if (row.rowCount === 0) return res.status(404).send('Not found');
      const u = row.rows[0];

      const [roleRow, viewRow] = await Promise.all([
        db.query(
          `SELECT COUNT(*) AS c FROM verified_roles WHERE user_id = $1 AND is_active = true AND is_public = true`,
          [u.id]
        ),
        db.query(
          `SELECT COUNT(*) AS c FROM analytics_events WHERE user_id = $1 AND type = 'profile_view'`,
          [u.id]
        ),
      ]);

      const avatarUrl = u.avatar_url ||
        (u.avatar_hash
          ? `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar_hash}.png?size=256`
          : null);

      const avatarData = avatarUrl ? await fetchAvatarBase64(avatarUrl) : null;

      const svg = buildSvg({
        name: u.display_name || u.discord_username || slug,
        bio: u.bio || 'Discord identity, verified.',
        slug,
        accent: u.accent_color,
        avatarData,
        roleCount: Number(roleRow.rows[0]?.c || 0),
        viewCount: Number(viewRow.rows[0]?.c || 0),
      });

      const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
      cache.set(slug, { buffer, expires: Date.now() + CACHE_TTL });

      // Keep the cache from growing unbounded
      if (cache.size > 500) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
        if (oldest) cache.delete(oldest[0]);
      }

      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=600');
      res.send(buffer);
    } catch (err) {
      console.error('[og] image generation failed:', err.message);
      res.status(500).send('Image generation failed');
    }
  };
}

module.exports = { createOgRoute };
