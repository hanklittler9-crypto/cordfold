const { ollamaStatus, ollamaChat, parseModelJson, OLLAMA_MODEL } = require('../ai-builder');
const { SEP11_MESSAGE, isIncidentQuestion } = require('../platform-status');

const ALLOWED = new Set([
  'verify', 'profile', 'whois', 'help', 'pro', 'status', 'announce', 'reply', 'roles', 'servers',
]);

const FACTS = `Cordfol facts:
- Site: https://cordfol.org — sign in with Discord. Dashboard: https://dashboard.cordfol.org
- Profiles prove Discord roles via bot verify or OAuth scan. Nobody types fake roles.
- Roles picker: https://cordfol.org/roles
- Server hubs: https://cordfol.org/servers — one server is /s/{guildId}
- Compare / random: https://cordfol.org/compare and /random
- Status: https://cordfol.org/status
- Pro is founder-granted with /pro give. Not Stripe.
- Support Discord: https://discord.gg/wcrCgc6pMf
- Prefix is usually "." — .verify .cordfol .whois .roles .help`;

function heuristicPlan(text, mentionIds, ctx = {}) {
  const t = String(text || '').toLowerCase();
  const target = mentionIds[0] || null;
  const actions = [];

  if (/\b(verify|sync|scan|update).{0,24}\b(role|profile|me|my)\b|\bverify me\b|\bscan (my )?roles\b|\badd my roles\b/.test(t) || t === 'verify') {
    actions.push({ type: 'verify' });
  }
  if (/\b(my (profile|link|page|cordfol)|profile link|drop my link|where('?s| is) my (page|profile))\b/.test(t) || t === 'profile') {
    actions.push({ type: 'profile' });
  }
  if (/\b(whois|who is|look ?up|find)\b/.test(t) && (target || /\b(them|him|her|this|that)\b/.test(t))) {
    actions.push({ type: 'whois', userId: target });
  }
  if (/\b(help|commands|what can you|how do (i|you) use)\b/.test(t) && !actions.length) {
    actions.push({ type: 'help' });
  }
  if (/\broles?\b/.test(t) && /\b(pick|page|pronoun|about you|who (am|i)|cordfol\.org\/roles)\b/.test(t)) {
    actions.push({ type: 'roles' });
  }
  if (/\bservers?\b/.test(t) && /\b(page|hub|directory|list|where)\b/.test(t)) {
    actions.push({ type: 'servers' });
  }
  if (/\bpro\b/.test(t) && (/\bgive\b|\bgrant\b/.test(t))) {
    actions.push({ type: 'pro', op: 'give', userId: target });
  } else if (/\bpro\b/.test(t) && (/\btake\b|\bremove\b/.test(t))) {
    actions.push({ type: 'pro', op: 'take', userId: target });
  } else if (/\b(do i have pro|am i pro|have pro|got pro|my plan|check.{0,12}pro)\b/.test(t)) {
    actions.push({ type: 'pro', op: 'check', userId: target });
  }
  if (isIncidentQuestion(t)) {
    return { say: SEP11_MESSAGE, actions: [{ type: 'reply' }], source: 'heuristic', talk: false };
  }
  if (/\b(site )?status\b/.test(t) && !/\bset\b/.test(t) && !/\brelationship\b/.test(t)) {
    actions.push({ type: 'status' });
  }

  if (actions.length) {
    return { say: '', actions, source: 'heuristic', talk: false };
  }

  return {
    say: faqReply(t, ctx),
    actions: [{ type: 'reply' }],
    source: 'heuristic',
    talk: true,
  };
}

function faqReply(t, ctx = {}) {
  if (/\b(claim|sign ?up|create|make).{0,20}\b(profile|page|account|handle)\b|\bhow do i (start|join|get (a )?page)\b/.test(t)) {
    return 'Sign in with Discord at cordfol.org, pick a handle, then ask me to verify you.';
  }
  if (/\b(dashboard|edit|builder|theme|css)\b/.test(t)) {
    return 'Dashboard is dashboard.cordfol.org — sign in, then the AI builder or the knobs. Remix lives there too.';
  }
  if (/\bpro\b/.test(t) && /\b(how|get|buy|price|cost|stripe)\b/.test(t)) {
    return 'Pro is not checkout yet. Astro grants it in Discord with /pro give.';
  }
  if (/\b(invite|join).{0,16}(cordfol|server|discord)\b|\bdiscord\.gg\b/.test(t)) {
    return 'Cordfol Discord: https://discord.gg/wcrCgc6pMf';
  }
  if (ctx.slug && /\b(my (link|url|handle)|what('?s| is) my slug)\b/.test(t)) {
    return `You're cordfol.org/${ctx.slug}`;
  }
  return '';
}

function sanitizePlan(parsed, fallback, mentionIds) {
  if (!parsed || typeof parsed !== 'object') return fallback;
  const say = String(parsed.say || '').slice(0, 1800);
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
    talk: false,
  };
}

function talkSystem({ authorName, isFounder, isOps, slug, plan, guildName }) {
  const who = slug ? `https://cordfol.org/${slug}` : 'no Cordfol page yet';
  return `You are Cordfol's Discord bot in a real chat. Sound like a person, not a ticket form.
${FACTS}
This message is from ${authorName} (founder=${!!isFounder}, staff=${!!isOps}, plan=${plan || 'unknown'}, page=${who}, server=${guildName || 'unknown'}).
Rules:
- Answer the thing they said. 1-5 short sentences. Casual.
- Use their page link if it helps. Never invent other people's handles or Discord IDs.
- If they want you to verify, look someone up, or grant Pro, say you'll do it in one short line — the bot runs the action separately.
- September 11 outage: if asked, use this exact line and nothing extra: ${JSON.stringify(SEP11_MESSAGE)}
- No exploits, no sexual content involving minors, no fake private data.`;
}

async function talkWithOllama({ text, history = [], ctx, model }) {
  const turns = [];
  for (const m of (history || []).slice(-8)) {
    const content = String(m.content || '').trim().slice(0, 400);
    if (!content) continue;
    turns.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }
  if (!turns.length || turns[turns.length - 1].content !== String(text || '').slice(0, 400)) {
    turns.push({ role: 'user', content: String(text || '').slice(0, 500) });
  }
  const content = await ollamaChat({
    model,
    json: false,
    temperature: 0.7,
    messages: [
      { role: 'system', content: talkSystem(ctx) },
      ...turns,
    ],
  });
  return String(content || '').replace(/\s+\n/g, '\n').trim().slice(0, 1800);
}

async function planWithOllama({ text, mentionIds, ctx, model }) {
  const prompt = `Turn this Discord message into JSON only:
{"say":"short line or empty","actions":[{"type":"verify|profile|whois|help|pro|status|announce|roles|servers|reply","userId":"","op":"give|take|check","message":""}]}
Rules:
- Do the thing they asked. Multiple actions ok.
- Never invent Discord IDs. Mentions: ${JSON.stringify(mentionIds)}
- pro/announce only if they clearly asked.
- "do I have pro" → pro check, empty userId.
- How-to questions → type reply and put the answer in say.
- Keep say under 2 sentences.
User ${ctx.authorName} said:
${String(text || '').slice(0, 500)}`;

  const content = await ollamaChat({
    model,
    json: true,
    temperature: 0.2,
    prompt,
  });
  return parseModelJson(content);
}

async function interpretBotRequest({
  text,
  mentionIds = [],
  authorName,
  isFounder,
  isOps,
  slug = null,
  plan = null,
  guildName = null,
  history = [],
} = {}) {
  const ctx = { authorName, isFounder, isOps, slug, plan, guildName };
  const fallback = heuristicPlan(text, mentionIds, ctx);
  const status = await ollamaStatus();

  if (!status.available) {
    if (fallback.talk && !fallback.say) {
      fallback.say = slug
        ? `I can verify you, drop ${slug}'s link, look someone up, or point at cordfol.org/roles.`
        : 'I can verify you, drop your profile link, look someone up, or point at cordfol.org/roles.';
    }
    return fallback;
  }

  const model = status.model || OLLAMA_MODEL;
  const hasJob = fallback.actions.some((a) => a.type !== 'reply');

  try {
    if (hasJob && !fallback.talk) {
      return fallback;
    }

    const looksLikeCommand = /^(verify|profile|whois|help|pro|status|roles|servers|announce)\b/i.test(String(text || '').trim());
    if (looksLikeCommand) {
      const parsed = await planWithOllama({ text, mentionIds, ctx, model });
      return sanitizePlan(parsed, fallback, mentionIds);
    }

    const say = await talkWithOllama({ text, history, ctx, model });
    return {
      say: say || fallback.say || 'Yeah?',
      actions: fallback.actions,
      source: 'ollama',
      talk: true,
    };
  } catch (err) {
    console.error('[bot-ai] interpret failed:', err.message);
    if (fallback.talk && !fallback.say) {
      fallback.say = 'Model hiccup — say that again, or use .verify / .cordfol / .help.';
    }
    return fallback;
  }
}

module.exports = { interpretBotRequest, heuristicPlan };
