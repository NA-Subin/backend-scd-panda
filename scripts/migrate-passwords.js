import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const TABLES = ['employee_officers', 'employee_drivers'];

async function main() {
  for (const table of TABLES) {
    const { rows } = await pool.query(`SELECT "row_key", "password" FROM "${table}"`);
    let updated = 0;
    for (const row of rows) {
      const plain = row.password;
      if (!plain || plain.startsWith('$2')) continue; // already hashed or empty
      const hash = await bcrypt.hash(plain, 10);
      await pool.query(`UPDATE "${table}" SET "password" = $1 WHERE "row_key" = $2`, [
        hash,
        row.row_key,
      ]);
      updated++;
    }
    console.log(`${table}: hashed ${updated} of ${rows.length} passwords`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
