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

function sendImage(res, buffer, format = 'png', maxAge = 600) {
  res.set('Content-Type', format === 'jpeg' ? 'image/jpeg' : 'image/png');
  res.set('Cache-Control', `public, max-age=${maxAge}`);
  return res.send(buffer);
}

async function rasterize(svg, format = 'png') {
  const img = sharp(Buffer.from(svg));
  return format === 'jpeg' ? img.jpeg({ quality: 88 }).toBuffer() : img.png().toBuffer();
}

function buildHomeSvg({ name, bio, slug, accent, avatarData, viewCount, hasSpotify }) {
  const safeAccent = /^#[0-9a-fA-F]{6}$/.test(accent || '') ? accent : '#c46bff';
  const initial = esc((name[0] || '?').toUpperCase());
  const avatar = avatarData
    ? `<image href="${avatarData}" x="848" y="118" width="144" height="144" clip-path="url(#homeAv)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="920" cy="190" r="72" fill="${safeAccent}"/>
       <text x="920" y="214" font-family="DejaVu Sans, Arial, sans-serif" font-size="52" font-weight="700" fill="#ffffff" text-anchor="middle">${initial}</text>`;

  const spotify = hasSpotify ? `
    <rect x="748" y="430" width="344" height="86" rx="16" fill="#12281c" stroke="rgba(29,185,84,0.35)" stroke-width="1"/>
    <text x="770" y="458" font-family="DejaVu Sans, Arial, sans-serif" font-size="13" letter-spacing="1.4" fill="#1DB954">LISTENING ON SPOTIFY</text>
    <text x="770" y="486" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="700" fill="#f5f7fb">Now playing</text>
    <text x="770" y="508" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" fill="rgba(255,255,255,0.55)">Live on this profile</text>
  ` : `
    <rect x="748" y="448" rx="14" ry="14" width="168" height="36" fill="rgba(196,107,255,0.16)" stroke="rgba(196,107,255,0.4)" stroke-width="1"/>
    <text x="832" y="472" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="700" fill="#e8d2ff" text-anchor="middle">Verified profile</text>
  `;

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <clipPath id="homeAv"><circle cx="920" cy="190" r="72"/></clipPath>
    <radialGradient id="homeGlow" cx="78%" cy="42%" r="48%">
      <stop offset="0%" stop-color="${safeAccent}" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="${safeAccent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cardFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#141018" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#0a0a0c" stop-opacity="0.92"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="#050507"/>
  <rect width="1200" height="630" fill="url(#homeGlow)"/>
  <text x="72" y="88" font-family="DejaVu Sans, Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="4" fill="rgba(255,255,255,0.4)">CORDFOL</text>
  <text x="72" y="250" font-family="DejaVu Sans, Arial, sans-serif" font-size="62" font-weight="700" fill="#f7f7fb">YOUR DISCORD</text>
  <text x="72" y="322" font-family="DejaVu Sans, Arial, sans-serif" font-size="62" font-weight="700" fill="#f7f7fb">IDENTITY,</text>
  <text x="72" y="394" font-family="DejaVu Sans, Arial, sans-serif" font-size="62" font-weight="700" fill="#f7f7fb">DESIGNED.</text>
  <text x="72" y="460" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" fill="rgba(255,255,255,0.55)">AI builder · custom photos · verified roles</text>
  <text x="72" y="560" font-family="DejaVu Sans, Arial, sans-serif" font-size="18" fill="rgba(255,255,255,0.32)">cordfol.org/${esc(slug)}</text>

  <rect x="720" y="64" width="400" height="502" rx="32" fill="rgba(10,10,12,0.72)" stroke="rgba(255,255,255,0.1)" stroke-width="1.5"/>
  <rect x="720" y="64" width="400" height="150" rx="32" fill="url(#cardFade)"/>
  <rect x="848" y="188" width="144" height="26" fill="#0a0a0c"/>
  <rect x="812" y="86" rx="12" ry="12" width="196" height="30" fill="rgba(0,0,0,0.45)"/>
  <text x="910" y="107" font-family="DejaVu Sans, Arial, sans-serif" font-size="14" fill="rgba(255,255,255,0.5)" text-anchor="middle">cordfol.org/${esc(slug)}</text>
  <circle cx="920" cy="190" r="76" fill="none" stroke="${safeAccent}" stroke-width="4"/>
  ${avatar}
  <text x="920" y="372" font-family="DejaVu Sans, Arial, sans-serif" font-size="36" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(truncate(name, 16))}</text>
  <text x="920" y="408" font-family="DejaVu Sans, Arial, sans-serif" font-size="18" fill="rgba(255,255,255,0.55)" text-anchor="middle">${esc(truncate(bio, 34))}</text>
  ${spotify}
  <text x="748" y="548" font-family="DejaVu Sans, Arial, sans-serif" font-size="14" fill="rgba(255,255,255,0.35)">${viewCount > 0 ? formatCount(viewCount) + ' views' : 'Verified on Discord'}</text>
</svg>`;
}

function buildDiscoverSvg(profiles) {
  const slice = profiles.slice(0, 3);
  const clipDefs = slice.map((p, i) => {
    const x = 72 + i * 360;
    return `<clipPath id="dAv${i}"><rect x="${x + 28}" y="268" width="72" height="72" rx="16"/></clipPath>`;
  }).join('');
  const cards = slice.map((p, i) => {
    const x = 72 + i * 360;
    const accent = /^#[0-9a-fA-F]{6}$/.test(p.accent || '') ? p.accent : '#c46bff';
    const initial = esc((p.name[0] || '?').toUpperCase());
    const avatar = p.avatarData
      ? `<image href="${p.avatarData}" x="${x + 28}" y="268" width="72" height="72" clip-path="url(#dAv${i})" preserveAspectRatio="xMidYMid slice"/>`
      : `<rect x="${x + 28}" y="268" width="72" height="72" rx="16" fill="${accent}"/>
         <text x="${x + 64}" y="316" font-family="DejaVu Sans, Arial, sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${initial}</text>`;
    return `
      <rect x="${x}" y="236" width="336" height="288" rx="22" fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
      <rect x="${x}" y="236" width="336" height="4" fill="${accent}"/>
      ${avatar}
      <text x="${x + 116}" y="300" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="700" fill="#f5f7fb">${esc(truncate(p.name, 14))}</text>
      <text x="${x + 116}" y="326" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" fill="rgba(255,255,255,0.4)">cordfol.org/${esc(p.slug)}</text>
      <text x="${x + 28}" y="384" font-family="DejaVu Sans, Arial, sans-serif" font-size="16" fill="rgba(255,255,255,0.55)">${esc(truncate(p.bio || 'Verified Discord profile', 36))}</text>
      <text x="${x + 28}" y="486" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" fill="rgba(255,255,255,0.38)">${p.views7d > 0 ? formatCount(p.views7d) + ' views this week' : formatCount(p.viewsAll || 0) + ' views'} · ${p.roleCount || 0} roles</text>
    `;
  }).join('');

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <radialGradient id="discGlow" cx="90%" cy="0%" r="55%">
      <stop offset="0%" stop-color="#c46bff" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#c46bff" stop-opacity="0"/>
    </radialGradient>
    ${clipDefs}
  </defs>
  <rect width="1200" height="630" fill="#050507"/>
  <rect width="1200" height="630" fill="url(#discGlow)"/>
  <text x="72" y="86" font-family="DejaVu Sans, Arial, sans-serif" font-size="16" letter-spacing="3.2" fill="rgba(255,255,255,0.4)">TRENDING THIS WEEK</text>
  <text x="72" y="168" font-family="DejaVu Sans, Arial, sans-serif" font-size="48" font-weight="700" fill="#f7f7fb">DISCOVER VERIFIED</text>
  <text x="72" y="220" font-family="DejaVu Sans, Arial, sans-serif" font-size="48" font-weight="700" fill="#f7f7fb">PROFILES.</text>
  ${cards}
</svg>`;
}

async function loadFeaturedProfile(db, slug) {
  const row = await db.query(`
    SELECT u.id, u.discord_id, u.discord_username, u.display_name, u.bio,
           u.avatar_hash, u.avatar_url, u.slug, u.spotify_enabled, u.spotify_public,
           t.accent_color
    FROM users u
    LEFT JOIN themes t ON t.id = u.theme_id
    WHERE u.slug = $1
  `, [slug]);
  if (row.rowCount === 0) return null;
  const u = row.rows[0];
  const viewRow = await db.query(
    `SELECT COUNT(*) AS c FROM analytics_events WHERE user_id = $1 AND type = 'profile_view'`,
    [u.id]
  );
  const avatarUrl = u.avatar_url ||
    (u.avatar_hash ? `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar_hash}.png?size=256` : null);
  return {
    name: u.display_name || u.discord_username || slug,
    bio: u.bio || 'Discord identity, verified.',
    slug: u.slug || slug,
    accent: u.accent_color,
    avatarData: avatarUrl ? await fetchAvatarBase64(avatarUrl) : null,
    viewCount: Number(viewRow.rows[0]?.c || 0),
    hasSpotify: !!(u.spotify_enabled && u.spotify_public),
  };
}

function createHomeOgRoute(db, format = 'png') {
  const featuredSlug = String(process.env.FEATURED_OG_SLUG || 'fkastro').toLowerCase();
  const cacheKey = `__home__:${format}`;
  return async function homeOgHandler(req, res) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return sendImage(res, cached.buffer, format);

    try {
      let featured = await loadFeaturedProfile(db, featuredSlug);
      if (!featured) {
        const fallback = await db.query(`
          SELECT slug FROM users WHERE slug IS NOT NULL ORDER BY created_at DESC LIMIT 1
        `);
        if (fallback.rowCount) featured = await loadFeaturedProfile(db, fallback.rows[0].slug);
      }
      const svg = buildHomeSvg(featured || {
        name: 'Cordfol',
        bio: 'AI profile builder',
        slug: 'you',
        accent: '#c46bff',
        avatarData: null,
        viewCount: 0,
        hasSpotify: false,
      });
      const buffer = await rasterize(svg, format);
      cache.set(cacheKey, { buffer, expires: Date.now() + CACHE_TTL });
      return sendImage(res, buffer, format);
    } catch (err) {
      console.error('[og] home image failed:', err.message);
      return res.status(500).send('Image generation failed');
    }
  };
}

function createDiscoverOgRoute(db, format = 'png') {
  const cacheKey = `__discover__:${format}`;
  return async function discoverOgHandler(req, res) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return sendImage(res, cached.buffer, format);

    try {
      const rows = await db.query(`
        SELECT u.slug, COALESCE(u.display_name, u.discord_username) AS name,
               u.bio, u.discord_id, u.avatar_hash, u.avatar_url,
               t.accent_color,
               COALESCE(v7.views, 0) AS views_7d,
               COALESCE(va.views, 0) AS views_all,
               COALESCE(r.role_count, 0) AS role_count
        FROM users u
        LEFT JOIN themes t ON t.id = u.theme_id
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS views FROM analytics_events
          WHERE type = 'profile_view' AND created_at >= NOW() - INTERVAL '7 days'
          GROUP BY user_id
        ) v7 ON v7.user_id = u.id
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS views FROM analytics_events
          WHERE type = 'profile_view' GROUP BY user_id
        ) va ON va.user_id = u.id
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS role_count FROM verified_roles
          WHERE is_active = true AND is_public = true GROUP BY user_id
        ) r ON r.user_id = u.id
        WHERE u.slug IS NOT NULL
        ORDER BY COALESCE(v7.views, 0) DESC, COALESCE(va.views, 0) DESC
        LIMIT 3
      `);

      const profiles = await Promise.all(rows.rows.map(async (row) => {
        const avatarUrl = row.avatar_url ||
          (row.avatar_hash ? `https://cdn.discordapp.com/avatars/${row.discord_id}/${row.avatar_hash}.png?size=128` : null);
        return {
          slug: row.slug,
          name: row.name || row.slug,
          bio: row.bio || '',
          accent: row.accent_color,
          views7d: Number(row.views_7d),
          viewsAll: Number(row.views_all),
          roleCount: Number(row.role_count),
          avatarData: avatarUrl ? await fetchAvatarBase64(avatarUrl) : null,
        };
      }));

      const svg = buildDiscoverSvg(profiles);
      const buffer = await rasterize(svg, format);
      cache.set(cacheKey, { buffer, expires: Date.now() + CACHE_TTL });
      return sendImage(res, buffer, format);
    } catch (err) {
      console.error('[og] discover image failed:', err.message);
      return res.status(500).send('Image generation failed');
    }
  };
}

module.exports = { createOgRoute, createHomeOgRoute, createDiscoverOgRoute };
