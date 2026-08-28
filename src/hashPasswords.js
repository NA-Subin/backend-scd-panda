import bcrypt from 'bcryptjs';

const PASSWORD_TABLES = ['employee_officers', 'employee_drivers'];

// Hashes any plaintext passwords in place (idempotent - skips values already
// looking like a bcrypt hash). Firebase JSON re-imports overwrite these
// columns with plaintext, so this needs to run after every import too.
export async function hashPlaintextPasswords(pool) {
  const results = [];
  for (const table of PASSWORD_TABLES) {
    const { rows } = await pool.query(`SELECT "row_key", "password" FROM "${table}"`);
    let updated = 0;
    for (const row of rows) {
      const plain = row.password;
      if (!plain || plain.startsWith('$2')) continue;
      const hash = await bcrypt.hash(plain, 10);
      await pool.query(`UPDATE "${table}" SET "password" = $1 WHERE "row_key" = $2`, [hash, row.row_key]);
      updated++;
    }
    results.push({ table, updated, total: rows.length });
  }
  return results;
}
