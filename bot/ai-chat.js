const { ollamaStatus, ollamaChat, parseModelJson, OLLAMA_MODEL } = require('../ai-builder');

const ALLOWED = new Set([
  'verify', 'profile', 'whois', 'help', 'pro', 'status', 'announce', 'reply',
]);

function heuristicPlan(text, mentionIds) {
  const t = String(text || '').toLowerCase();
  const target = mentionIds[0] || null;
  const actions = [];
  if (/\b(verify|sync|scan).{0,20}\b(role|profile|me|my)\b|\bverify me\b|\bscan (my )?roles\b/.test(t) || t === 'verify') {
    actions.push({ type: 'verify' });
  }
  if (/\b(my (profile|link|page|cordfol)|profile link|cordfol\.org)\b/.test(t) || t === 'profile') {
    actions.push({ type: 'profile' });
  }
  if (/\b(whois|who is|look ?up|find)\b/.test(t)) {
    actions.push({ type: 'whois', userId: target });
  }
  if (/\b(help|commands|what can you|how do i)\b/.test(t) && !actions.length) {
    actions.push({ type: 'help' });
  }
  if (/\bpro\b/.test(t) && (/\bgive\b|\bgrant\b/.test(t))) {
    actions.push({ type: 'pro', op: 'give', userId: target });
  } else if (/\bpro\b/.test(t) && (/\btake\b|\bremove\b/.test(t))) {
    actions.push({ type: 'pro', op: 'take', userId: target });
  } else if (/\bpro\b/.test(t) && /\bcheck\b/.test(t)) {
    actions.push({ type: 'pro', op: 'check', userId: target });
  }
  if (/\b(site )?status\b/.test(t) && !/\bset\b/.test(t)) {
    actions.push({ type: 'status' });
  }
  if (!actions.length) {
    actions.push({ type: 'reply' });
  }
  return {
    say: actions[0]?.type === 'reply'
      ? 'I can verify you, drop your profile link, look someone up, or grant Pro if Astro asks.'
      : '',
    actions,
    source: 'heuristic',
  };
}

function sanitizePlan(parsed, fallback, mentionIds) {
  if (!parsed || typeof parsed !== 'object') return fallback;
  const say = String(parsed.say || '').slice(0, 400);
  const raw = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions = raw.slice(0, 4).map((a) => {
    const type = ALLOWED.has(a?.type) ? a.type : 'reply';
    const out = { type };
    if (type === 'whois' || type === 'pro') {
      const id = String(a.userId || mentionIds[0] || '').replace(/\D/g, '');
      if (id) out.userId = id;
    }
    if (type === 'pro') {
      out.op = ['give', 'take', 'check'].includes(a.op) ? a.op : 'check';
    }
    if (type === 'announce') {
      out.message = String(a.message || '').slice(0, 400);
    }
    return out;
  }).filter((a) => a.type);
  return {
    say,
    actions: actions.length ? actions : fallback.actions,
    source: 'ollama',
  };
}

async function interpretBotRequest({ text, mentionIds = [], authorName, isFounder, isOps }) {
  const fallback = heuristicPlan(text, mentionIds);
  const status = await ollamaStatus();
  if (!status.available) return fallback;

  const prompt = `You are Cordfol's Discord bot. Turn one user message into JSON only:
{
  "say": "short helpful reply, or empty if an action is enough",
  "actions": [
    {"type":"verify"},
    {"type":"profile"},
    {"type":"whois","userId":"snowflake or empty"},
    {"type":"help"},
    {"type":"pro","op":"give|take|check","userId":"snowflake"},
    {"type":"status"},
    {"type":"announce","message":"text"},
    {"type":"reply"}
  ]
}
Rules:
- Do the thing they asked. Multiple actions are ok (verify + profile).
- Never invent Discord IDs. Use mentioned IDs only: ${JSON.stringify(mentionIds)}
- pro/announce only if they clearly asked. The bot will still permission-check.
- If they just asked a how-to about Cordfol (claim handle, Pro, remix, dashboard), use type reply and answer in "say".
- Keep say under 3 sentences, casual.
User ${authorName} (founder=${isFounder}, staff=${isOps}) said:
${String(text || '').slice(0, 500)}`;

  try {
    const content = await ollamaChat({ model: OLLAMA_MODEL, prompt });
    const parsed = parseModelJson(content);
    return sanitizePlan(parsed, fallback, mentionIds);
  } catch (err) {
    console.error('[bot-ai] interpret failed:', err.message);
    return fallback;
  }
}

module.exports = { interpretBotRequest, heuristicPlan };
