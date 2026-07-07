const nodemailer = require('nodemailer');

const PUBLIC_HOST = 'cordfol.org';
const DASHBOARD_URL = 'https://dashboard.cordfol.org/dashboard.html';
const API_BASE = process.env.PUBLIC_API_URL || 'https://api.cordfol.org';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return transporter;
}

function isConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Branded layout ────────────────────────────────────────────────────────────
// Dark Cordfol-styled shell shared by every email. Inline styles only —
// email clients strip <style> blocks.
function renderEmail({ preheader, kicker, title, bodyHtml, ctaLabel, ctaUrl, footNote }) {
  const accent = '#5865F2';
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0b0b10;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader || '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0b10;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;">

        <!-- Header -->
        <tr><td style="padding:0 8px 18px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:26px;height:26px;background:${accent};border-radius:8px;"></td>
            <td style="padding-left:10px;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:800;color:#f5f7fb;letter-spacing:0.5px;">CORDFOL</td>
          </tr></table>
        </td></tr>

        <!-- Card -->
        <tr><td style="background-color:#14151d;border:1px solid #23242e;border-radius:16px;padding:34px 32px;">
          ${kicker ? `<div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${accent};margin-bottom:14px;">${esc(kicker)}</div>` : ''}
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:23px;font-weight:700;color:#f5f7fb;line-height:1.3;margin-bottom:16px;">${title}</div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#b9bdc9;line-height:1.75;">
            ${bodyHtml}
          </div>
          ${ctaUrl ? `
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 6px;"><tr>
            <td style="background:${accent};border-radius:10px;">
              <a href="${ctaUrl}" style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">${esc(ctaLabel || 'Open Cordfol')}</a>
            </td>
          </tr></table>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b6f7b;margin-top:14px;word-break:break-all;">Button not working? Copy this link:<br><a href="${ctaUrl}" style="color:#8b9fff;">${ctaUrl}</a></div>
          ` : ''}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:22px 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#5c606c;line-height:1.7;">
          ${footNote ? `${esc(footNote)}<br>` : ''}
          Sent by <a href="https://${PUBLIC_HOST}" style="color:#8b9fff;text-decoration:none;">cordfol.org</a> — your Discord identity, verified.
          You're getting this because this address is linked to a Cordfol profile.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendMail({ to, subject, html, text }) {
  const transport = getTransporter();
  if (!transport) {
    console.warn('[email] SMTP not configured — set SMTP_USER and SMTP_PASS');
    return false;
  }

  await transport.sendMail({
    from: `"Cordfol" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text,
  });
  return true;
}

// ── Verification ──────────────────────────────────────────────────────────────
async function sendVerificationEmail({ to, displayName, token }) {
  const verifyUrl = `${API_BASE}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const name = displayName || 'there';

  return sendMail({
    to,
    subject: 'Verify your email — Cordfol',
    text: `Hi ${name},\n\nVerify your email for Cordfol:\n${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: renderEmail({
      preheader: 'One click and your email is linked to your Cordfol profile.',
      kicker: 'Email verification',
      title: 'Confirm this address',
      bodyHtml: `
        <p style="margin:0 0 12px;">Hey ${esc(name)},</p>
        <p style="margin:0 0 12px;">Verify this email to link it to your Cordfol account. You'll get role-change alerts and account recovery — nothing spammy.</p>
      `,
      ctaLabel: 'Verify Email',
      ctaUrl: verifyUrl,
      footNote: 'Link expires in 24 hours. Didn\'t request this? Just ignore it.',
    }),
  });
}

// ── Setup reminder ────────────────────────────────────────────────────────────
async function sendSetupReminderEmail({ to, displayName, slug }) {
  const profileUrl = `https://${PUBLIC_HOST}/${slug}`;
  const name = displayName || 'there';

  return sendMail({
    to,
    subject: 'Your Cordfol profile is almost live',
    text: `Hi ${name},\n\nYour Cordfol profile is almost ready. Finish setup in the dashboard:\n${DASHBOARD_URL}\n\nYour page: ${profileUrl}`,
    html: renderEmail({
      preheader: 'A bio, a banner, and you\'re done — takes about two minutes.',
      kicker: 'Finish setup',
      title: 'Your page is waiting',
      bodyHtml: `
        <p style="margin:0 0 12px;">Hey ${esc(name)},</p>
        <p style="margin:0 0 12px;">You claimed <strong style="color:#f5f7fb;">${esc(PUBLIC_HOST)}/${esc(slug)}</strong> but haven't finished setting it up. Two minutes gets you:</p>
        <p style="margin:0 0 4px;">— A bio and social links</p>
        <p style="margin:0 0 4px;">— A banner and theme that's actually yours</p>
        <p style="margin:0 0 12px;">— Verified Discord roles people can trust</p>
      `,
      ctaLabel: 'Open Dashboard',
      ctaUrl: DASHBOARD_URL,
      footNote: `Your public page: ${profileUrl}`,
    }),
  });
}

// ── Role change alert ─────────────────────────────────────────────────────────
// Sent when a re-scan finds verified roles that went inactive (left server,
// role removed, etc). Only sent to verified emails.
async function sendRoleChangeEmail({ to, displayName, slug, lostRoles }) {
  const name = displayName || 'there';
  const profileUrl = `https://${PUBLIC_HOST}/${slug}`;
  const roleLines = lostRoles
    .slice(0, 6)
    .map(r => `— ${r.roleName || r.roleId} (${r.guildName || 'Unknown server'})`)
    .join('\n');
  const roleHtml = lostRoles
    .slice(0, 6)
    .map(r => `<p style="margin:0 0 6px;padding:10px 14px;background:#1b1c26;border:1px solid #262836;border-radius:10px;color:#f5f7fb;">${esc(r.roleName || r.roleId)} <span style="color:#6b6f7b;">· ${esc(r.guildName || 'Unknown server')}</span></p>`)
    .join('');
  const extra = lostRoles.length > 6
    ? `<p style="margin:8px 0 0;color:#6b6f7b;">…and ${lostRoles.length - 6} more.</p>`
    : '';

  return sendMail({
    to,
    subject: `${lostRoles.length} verified role${lostRoles.length === 1 ? '' : 's'} removed from your profile`,
    text: `Hi ${name},\n\nThese roles are no longer verified and were removed from your public profile:\n\n${roleLines}\n\nIf this is a mistake, rejoin the server or ask a mod, then rescan from your dashboard:\n${DASHBOARD_URL}`,
    html: renderEmail({
      preheader: 'A re-check found roles you no longer hold — your profile was updated.',
      kicker: 'Role check',
      title: `${lostRoles.length} role${lostRoles.length === 1 ? '' : 's'} no longer verified`,
      bodyHtml: `
        <p style="margin:0 0 14px;">Hey ${esc(name)},</p>
        <p style="margin:0 0 14px;">Our automatic re-check couldn't confirm these roles anymore, so they've been hidden from your public profile:</p>
        ${roleHtml}
        ${extra}
        <p style="margin:14px 0 0;">Left the server or lost the role on purpose? Nothing to do. If it's a mistake, get the role back and hit <strong style="color:#f5f7fb;">Rescan Guilds</strong> in your dashboard.</p>
      `,
      ctaLabel: 'Rescan My Roles',
      ctaUrl: DASHBOARD_URL,
      footNote: `Your public page: ${profileUrl}`,
    }),
  });
}

function profileNeedsSetup(user) {
  const slug = String(user.slug || '');
  const bio = String(user.bio || '').trim();
  const displayName = String(user.display_name || '').trim();
  const username = String(user.discord_username || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const slugLooksDefault = !slug || slug === username || /^[a-z0-9]+\d+$/.test(slug);
  return !bio || slugLooksDefault || !displayName;
}

async function maybeSendSetupReminder(db, userId) {
  if (!isConfigured()) return;

  try {
    const row = await db.query(`
      SELECT email, discord_username, display_name, slug, bio, setup_reminder_sent_at
      FROM users WHERE id = $1
    `, [userId]);

    if (row.rowCount === 0) return;
    const user = row.rows[0];

    // Only send to the address they added in the profile builder
    const profileEmail = String(user.email || '').trim();
    if (!profileEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profileEmail)) return;
    if (user.setup_reminder_sent_at) return;
    if (!profileNeedsSetup(user)) return;

    const sent = await sendSetupReminderEmail({
      to: profileEmail,
      displayName: user.display_name || user.discord_username,
      slug: user.slug,
    });

    if (sent) {
      await db.query(
        'UPDATE users SET setup_reminder_sent_at = NOW() WHERE id = $1',
        [userId]
      );
      console.log('[email] Setup reminder sent to profile email:', profileEmail);
    }
  } catch (err) {
    console.error('[email] Setup reminder failed:', err.message);
  }
}

// Called from scan.js after a re-scan flips roles inactive. Respects the
// user's email_role_alerts preference and requires a verified email.
async function maybeSendRoleChangeAlert(db, userId, lostRoles) {
  if (!isConfigured() || !lostRoles || !lostRoles.length) return;

  try {
    const row = await db.query(`
      SELECT email, email_verified, email_role_alerts, discord_username, display_name, slug
      FROM users WHERE id = $1
    `, [userId]);

    if (row.rowCount === 0) return;
    const user = row.rows[0];

    if (!user.email || !user.email_verified) return;
    if (user.email_role_alerts === false) return;

    const sent = await sendRoleChangeEmail({
      to: user.email,
      displayName: user.display_name || user.discord_username,
      slug: user.slug,
      lostRoles,
    });

    if (sent) console.log(`[email] Role change alert sent for user ${userId} (${lostRoles.length} roles)`);
  } catch (err) {
    console.error('[email] Role change alert failed:', err.message);
  }
}

module.exports = {
  isConfigured,
  renderEmail,
  sendVerificationEmail,
  sendSetupReminderEmail,
  sendRoleChangeEmail,
  maybeSendSetupReminder,
  maybeSendRoleChangeAlert,
  profileNeedsSetup,
};
