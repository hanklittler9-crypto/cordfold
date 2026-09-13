async function syncVerifiedRoles(db, member) {
  const guild = member.guild;
  const userRow = await db.query(
    'SELECT id, slug, display_name FROM users WHERE discord_id = $1',
    [member.id]
  );

  if (userRow.rowCount === 0) {
    return { ok: false, reason: 'no_account' };
  }

  const cordfolUser = userRow.rows[0];
  const roles = member.roles.cache
    .filter((r) => !r.managed && r.id !== guild.id)
    .map((r) => ({ id: r.id, name: r.name, color: r.color || 0 }));

  if (roles.length === 0) {
    return { ok: true, reason: 'no_roles', count: 0, slug: cordfolUser.slug, displayName: cordfolUser.display_name };
  }

  const values = roles.map((_role, idx) =>
    `(gen_random_uuid(), $1, $2, $3, $4, $${5 + (idx * 3)}, $${6 + (idx * 3)}, $${7 + (idx * 3)})`
  ).join(',');

  const params = [cordfolUser.id, guild.id, guild.name, guild.icon];
  roles.forEach((role) => {
    params.push(role.id, role.name, role.color);
  });

  await db.query(`
    INSERT INTO verified_roles
      (id, user_id, guild_id, guild_name, guild_icon_hash, role_id, role_name, role_color,
       verified_at, last_checked_at, is_active, proof_type, is_public, display_order)
    VALUES ${values}
    ON CONFLICT (user_id, guild_id, role_id)
    DO UPDATE SET
      role_name = EXCLUDED.role_name,
      role_color = EXCLUDED.role_color,
      is_active = true,
      last_checked_at = NOW(),
      proof_type = 'BOT'
  `, params);

  return {
    ok: true,
    count: roles.length,
    roles,
    slug: cordfolUser.slug,
    displayName: cordfolUser.display_name,
  };
}

module.exports = { syncVerifiedRoles };
