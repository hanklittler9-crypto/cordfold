const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || '';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 90000);

const ALLOWED_FONTS = ['DM Sans', 'Space Mono', 'Bebas Neue', 'Instrument Serif', 'Syne', 'IBM Plex Mono'];
const ALLOWED_LAYOUTS = ['centered', 'left', 'card', 'magazine'];
const ALLOWED_EFFECTS = ['none', 'glow', 'gradient', 'rainbow', 'sparkle'];
const ALLOWED_PARTICLES = ['dots', 'snow', 'rain', 'sakura', 'fireflies'];
const ALLOWED_SHAPES = ['circle', 'rounded', 'hex'];

const STYLE_PACKS = [
  { keys: ['neon', 'cyber', 'vapor', 'rave'], accent: '#c46bff', card: '#12081c', text: '#f6edff', bg: 'linear-gradient(135deg,#090014,#2a0850 55%,#00ffb2)', font: 'Syne', nameEffect: 'glow', particles: true, particleStyle: 'fireflies', layout: 'centered' },
  { keys: ['goth', 'dark', 'black', 'void', 'emo'], accent: '#ff4d6d', card: '#111111', text: '#f5f5f5', bg: 'linear-gradient(135deg,#050505,#1a0a12)', font: 'IBM Plex Mono', nameEffect: 'none', particles: false, particleStyle: 'dots', layout: 'centered' },
  { keys: ['clean', 'minimal', 'simple', 'white'], accent: '#5865F2', card: '#f4f4f6', text: '#111111', bg: 'linear-gradient(135deg,#e8e8ee,#ffffff)', font: 'DM Sans', nameEffect: 'none', particles: false, particleStyle: 'dots', layout: 'card' },
  { keys: ['pink', 'cute', 'kawaii', 'soft'], accent: '#ff7ad9', card: '#2a1224', text: '#ffe8f7', bg: 'linear-gradient(135deg,#1a0814,#4a1738 60%,#ff7ad9)', font: 'Syne', nameEffect: 'sparkle', particles: true, particleStyle: 'sakura', layout: 'centered' },
  { keys: ['ocean', 'blue', 'ice', 'frost'], accent: '#4cc9f0', card: '#0b1520', text: '#e8f6ff', bg: 'linear-gradient(135deg,#031018,#0b2a44)', font: 'Space Mono', nameEffect: 'glow', particles: true, particleStyle: 'snow', layout: 'left' },
  { keys: ['gold', 'luxury', 'rich', 'vip'], accent: '#f0b429', card: '#16120a', text: '#fff6d8', bg: 'linear-gradient(135deg,#0c0a06,#3a2a0a)', font: 'Instrument Serif', nameEffect: 'gradient', particles: true, particleStyle: 'dots', layout: 'magazine' },
  { keys: ['green', 'mint', 'matrix', 'slime'], accent: '#3dd68c', card: '#08140f', text: '#e8fff3', bg: 'linear-gradient(135deg,#03120b,#0c2a1a)', font: 'IBM Plex Mono', nameEffect: 'glow', particles: true, particleStyle: 'dots', layout: 'centered' },
  { keys: ['anime', 'weeb', 'manga'], accent: '#7c5cff', card: '#14101f', text: '#f3eeff', bg: 'linear-gradient(135deg,#0c0818,#2a1650)', font: 'Syne', nameEffect: 'rainbow', particles: true, particleStyle: 'sakura', layout: 'centered' },
];

function hexOk(value, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : fallback;
}

function pickPack(idea) {
  const text = String(idea || '').toLowerCase();
  return STYLE_PACKS.find((p) => p.keys.some((k) => text.includes(k))) || STYLE_PACKS[0];
}

function heuristicBuild(idea, colorHints = {}) {
  const pack = pickPack(idea);
  const cleaned = String(idea || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  const tagline = cleaned
    ? cleaned.split(/[.!?]/)[0].slice(0, 72)
    : 'Verified Discord identity';
  return {
    displayName: null,
    tagline,
    bio: cleaned
      ? cleaned.slice(0, 220)
      : 'Roles checked against Discord — not a caption I wrote myself.',
    pronouns: '',
    accentColor: hexOk(colorHints.accent, pack.accent),
    textColor: hexOk(colorHints.text, pack.text),
    cardColor: hexOk(colorHints.card, pack.card),
    backgroundType: 'gradient',
    backgroundValue: pack.bg,
    layout: pack.layout,
    font: ALLOWED_FONTS.includes(pack.font) ? pack.font : 'DM Sans',
    nameEffect: pack.nameEffect,
    particleStyle: pack.particleStyle,
    effects: {
      glassmorphism: true,
      particles: pack.particles,
      animatedBg: true,
      typewriterBio: true,
      tiltCard: true,
      entrySplash: false,
    },
    avatarShape: 'circle',
    source: 'heuristic',
  };
}

function sanitizeBuild(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fx = src.effects && typeof src.effects === 'object' ? src.effects : {};
  return {
    displayName: src.displayName ? String(src.displayName).slice(0, 40) : fallback.displayName,
    tagline: String(src.tagline || fallback.tagline).slice(0, 80),
    bio: String(src.bio || fallback.bio).slice(0, 280),
    pronouns: String(src.pronouns || '').slice(0, 32),
    accentColor: hexOk(src.accentColor, fallback.accentColor),
    textColor: hexOk(src.textColor, fallback.textColor),
    cardColor: hexOk(src.cardColor, fallback.cardColor),
    backgroundType: src.backgroundType === 'solid' ? 'solid' : 'gradient',
    backgroundValue: String(src.backgroundValue || fallback.backgroundValue).slice(0, 400),
    layout: ALLOWED_LAYOUTS.includes(src.layout) ? src.layout : fallback.layout,
    font: ALLOWED_FONTS.includes(src.font) ? src.font : fallback.font,
    nameEffect: ALLOWED_EFFECTS.includes(src.nameEffect) ? src.nameEffect : fallback.nameEffect,
    particleStyle: ALLOWED_PARTICLES.includes(src.particleStyle) ? src.particleStyle : fallback.particleStyle,
    effects: {
      glassmorphism: fx.glassmorphism !== false,
      particles: !!fx.particles,
      animatedBg: fx.animatedBg !== false,
      typewriterBio: !!fx.typewriterBio,
      tiltCard: fx.tiltCard !== false,
      entrySplash: !!fx.entrySplash,
    },
    avatarShape: ALLOWED_SHAPES.includes(src.avatarShape) ? src.avatarShape : 'circle',
    source: src.source || 'ollama',
  };
}

function parseModelJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

async function ollamaChat({ model, prompt, images }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const message = { role: 'user', content: prompt };
    if (images && images.length) message.images = images;
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [message],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText.slice(0, 200) || `Ollama HTTP ${res.status}`);
    }
    const data = await res.json();
    return data?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { available: false, host: OLLAMA_HOST, model: OLLAMA_MODEL };
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    return {
      available: true,
      host: OLLAMA_HOST,
      model: OLLAMA_MODEL,
      visionModel: OLLAMA_VISION_MODEL || null,
      models: names,
    };
  } catch {
    return { available: false, host: OLLAMA_HOST, model: OLLAMA_MODEL };
  }
}

function buildPrompt(idea, colorHints) {
  return `You design a public Discord identity page for Cordfol.
Return ONLY JSON with this shape:
{
  "displayName": "optional short name or null",
  "tagline": "max 72 chars vibe line",
  "bio": "1-2 sentences, max 220 chars, first person or punchy",
  "pronouns": "optional like they/them or empty",
  "accentColor": "#RRGGBB",
  "textColor": "#RRGGBB",
  "cardColor": "#RRGGBB",
  "backgroundType": "gradient" or "solid",
  "backgroundValue": "css color or linear-gradient(...)",
  "layout": "centered" | "card" | "left" | "magazine",
  "font": one of ${ALLOWED_FONTS.join(', ')},
  "nameEffect": one of ${ALLOWED_EFFECTS.join(', ')},
  "particleStyle": one of ${ALLOWED_PARTICLES.join(', ')},
  "effects": {
    "glassmorphism": true,
    "particles": true,
    "animatedBg": true,
    "typewriterBio": true,
    "tiltCard": true,
    "entrySplash": false
  },
  "avatarShape": "circle" | "rounded" | "hex"
}
User idea: ${String(idea || 'dark neon verified discord profile').slice(0, 800)}
Color hints from their photos: ${JSON.stringify(colorHints || {})}
Make it feel custom to THEIR idea, not generic SaaS. High contrast text on card.`;
}

async function buildProfile({ idea, images = [], colorHints = {} }) {
  const fallback = heuristicBuild(idea, colorHints);
  const status = await ollamaStatus();
  if (!status.available) {
    return { ...fallback, source: 'heuristic', notice: 'Ollama is offline on the server — used a local style mix. Start Ollama for the full AI builder.' };
  }

  const visionImages = images.slice(0, 3).map((img) => String(img).replace(/^data:[^;]+;base64,/, '')).filter(Boolean);
  const model = (visionImages.length && OLLAMA_VISION_MODEL) ? OLLAMA_VISION_MODEL : OLLAMA_MODEL;

  try {
    const content = await ollamaChat({
      model,
      prompt: buildPrompt(idea, colorHints),
      images: visionImages.length && OLLAMA_VISION_MODEL ? visionImages : undefined,
    });
    const parsed = parseModelJson(content);
    if (!parsed) return { ...fallback, source: 'heuristic', notice: 'The model returned a messy answer — used a local mix you can still edit.' };
    return sanitizeBuild({ ...parsed, source: 'ollama' }, fallback);
  } catch (err) {
    console.error('[ai-builder] ollama failed:', err.message);
    return { ...fallback, source: 'heuristic', notice: err.message.includes('abort') ? 'AI timed out — used a local style mix.' : 'Ollama failed — used a local style mix.' };
  }
}

module.exports = { buildProfile, ollamaStatus };
