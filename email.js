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

async function sendMail({ to, subject, html, text }) {
  const transport = getTransporter();
  if (!transport) {
    console.warn('[email] SMTP not configured — set SMTP_USER and SMTP_PASS');
    return false;
  }

  await transport.sendMail({
    from: `"Cordfol.io" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text,
  });
  return true;
}

async function sendVerificationEmail({ to, displayName, token }) {
  const verifyUrl = `${API_BASE}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const name = displayName || 'there';

  return sendMail({
    to,
    subject: 'Verify your Cordfol.io email',
    text: `Hi ${name},\n\nVerify your email for Cordfol.io:\n${verifyUrl}\n\nThis link expires in 24 hours.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
        <h2 style="color:#5865F2">Verify your email</h2>
        <p>Hi ${name},</p>
        <p>Confirm this address for your Cordfol.io account recovery and login options.</p>
        <p style="margin:28px 0">
          <a href="${verifyUrl}" style="background:#5865F2;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
            Verify Email
          </a>
        </p>
        <p style="color:#666;font-size:13px">Or copy this link:<br><a href="${verifyUrl}">${verifyUrl}</a></p>
        <p style="color:#999;font-size:12px">Link expires in 24 hours. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

async function sendSetupReminderEmail({ to, displayName, slug }) {
  const profileUrl = `https://${PUBLIC_HOST}/${slug}`;
  const name = displayName || 'there';

  return sendMail({
    to,
    subject: 'Finish setting up your Cordfol profile',
    text: `Hi ${name},\n\nYour Cordfol profile is almost ready. Finish setup in the dashboard:\n${DASHBOARD_URL}\n\nYour page: ${profileUrl}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
        <h2 style="color:#5865F2">Don't forget to finish your profile</h2>
        <p>Hi ${name},</p>
        <p>You logged into Cordfol.io but your public profile isn't fully set up yet.</p>
        <ul style="line-height:1.8;color:#333">
          <li>Add a bio and social links</li>
          <li>Pick your banner and theme</li>
          <li>Claim your handle at <strong>${PUBLIC_HOST}/${slug}</strong></li>
        </ul>
        <p style="margin:28px 0">
          <a href="${DASHBOARD_URL}" style="background:#5865F2;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
            Open Dashboard
          </a>
        </p>
        <p style="color:#666;font-size:13px">Your profile link: <a href="${profileUrl}">${profileUrl}</a></p>
      </div>
    `,
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

module.exports = {
  isConfigured,
  sendVerificationEmail,
  sendSetupReminderEmail,
  maybeSendSetupReminder,
  profileNeedsSetup,
};
