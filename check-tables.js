require('dotenv').config();
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    const result = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log('\n✅ Database Tables:\n');
    result.rows.forEach(row => console.log(`  • ${row.table_name}`));
    
    // Check specific columns for users table
    console.log('\n📊 Users Table Columns:\n');
    const columns = await db.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'users'
      ORDER BY ordinal_position
    `);
    
    columns.rows.forEach(col => console.log(`  • ${col.column_name}: ${col.data_type}`));
    
    await db.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
