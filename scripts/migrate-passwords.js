import { pool } from '../src/db.js';
import { hashPlaintextPasswords } from '../src/hashPasswords.js';

async function main() {
  const results = await hashPlaintextPasswords(pool);
  for (const r of results) {
    console.log(`${r.table}: hashed ${r.updated} of ${r.total} passwords`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
