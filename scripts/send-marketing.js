#!/usr/bin/env node
/**
 * Send the AI marketing email to verified users who opted in.
 *   node scripts/send-marketing.js
 */
require('dotenv').config({ path: require('path').join(require('os').homedir(), '.env') });
require('dotenv').config();

const { createPool } = require('../pg-pool');
const { sendMarketingEmail, isConfigured } = require('../email');

async function main() {
  if (!isConfigured()) {
    console.error('SMTP_USER / SMTP_PASS missing');
    process.exit(1);
  }
  const db = createPool(process.env.DATABASE_URL);
  const rows = await db.query(`
    SELECT id, email, display_name, discord_username, slug
    FROM users
    WHERE email_verified = true
      AND email IS NOT NULL
      AND COALESCE(email_marketing, true) = true
      AND (marketing_sent_at IS NULL OR marketing_sent_at < NOW() - INTERVAL '14 days')
    LIMIT 200
  `);
  let sent = 0;
  for (const u of rows.rows) {
    try {
      const ok = await sendMarketingEmail({
        to: u.email,
        displayName: u.display_name || u.discord_username,
        slug: u.slug,
      });
      if (ok) {
        await db.query('UPDATE users SET marketing_sent_at = NOW() WHERE id = $1', [u.id]);
        sent += 1;
        console.log('sent', u.email);
      }
    } catch (err) {
      console.error('fail', u.email, err.message);
    }
  }
  console.log(`done ${sent}/${rows.rowCount}`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
