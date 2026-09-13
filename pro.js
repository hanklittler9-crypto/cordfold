const FOUNDER_DISCORD_ID = '1127435524022472805';

function isProPlan(plan) {
  return String(plan || '').toUpperCase() === 'PRO';
}

function isFounderDiscordId(id) {
  return String(id || '') === FOUNDER_DISCORD_ID;
}

async function setUserPlanByDiscordId(db, discordId, plan) {
  const next = String(plan).toUpperCase() === 'PRO' ? 'PRO' : 'FREE';
  const row = await db.query(
    `UPDATE users
     SET plan = $1, updated_at = NOW()
     WHERE discord_id = $2
     RETURNING slug, display_name, discord_username, plan, discord_id`,
    [next, String(discordId)]
  );
  return row.rows[0] || null;
}

async function ensureFounderPro(db, discordId) {
  if (!isFounderDiscordId(discordId)) return null;
  return setUserPlanByDiscordId(db, FOUNDER_DISCORD_ID, 'PRO');
}

function proLimits(plan) {
  const pro = isProPlan(plan);
  return {
    pro,
    customLinks: pro ? 25 : 10,
    hostedApps: pro ? 10 : 3,
    pinnedRoles: pro ? 6 : 3,
    customCss: pro,
    analytics: pro,
    premiumThemes: pro,
    hideBrand: pro,
  };
}

module.exports = {
  FOUNDER_DISCORD_ID,
  isProPlan,
  isFounderDiscordId,
  setUserPlanByDiscordId,
  ensureFounderPro,
  proLimits,
};
