import bcrypt from 'bcryptjs';
import { columnNameForField } from './schema-manifest.js';

// table -> field (not column - resolved per-table below via the manifest,
// since the password field isn't always named/cased the same, e.g.
// truck_transport's is "PassWord" -> column "pass_word", not "password").
// truck_transport is a separate, pre-existing transport-truck credential
// flow (see routes/auth.js REGISTERABLE_TABLES) - previously left out of
// this list entirely, which meant a Firebase re-import left its passwords
// in plaintext, readable by any authenticated user via GET /api/truck_transport.
// Exported so routes/tables.js can redact these fields from generic table
// reads too - no frontend page reads a password field from those responses
// (confirmed by search), so there's no reason to ever send a hash, even a
// bcrypt one, to every authenticated user.
export const PASSWORD_TABLES = {
  employee_officers: 'Password',
  employee_drivers: 'Password',
  truck_transport: 'PassWord',
};

// Hashes any plaintext passwords in place (idempotent - skips values already
// looking like a bcrypt hash). Firebase JSON re-imports overwrite these
// columns with plaintext, so this needs to run after every import too.
export async function hashPlaintextPasswords(pool) {
  const results = [];
  for (const [table, field] of Object.entries(PASSWORD_TABLES)) {
    const column = columnNameForField(table, field);
    const { rows } = await pool.query(`SELECT "row_key", "${column}" AS password FROM "${table}"`);
    let updated = 0;
    for (const row of rows) {
      const plain = row.password;
      if (!plain || plain.startsWith('$2')) continue;
      const hash = await bcrypt.hash(plain, 10);
      await pool.query(`UPDATE "${table}" SET "${column}" = $1 WHERE "row_key" = $2`, [hash, row.row_key]);
      updated++;
    }
    results.push({ table, updated, total: rows.length });
  }
  return results;
}
