import fs from 'fs';
import { pool } from '../src/db.js';
import { buildImportPlan } from '../src/importData.js';
import { setManifest } from '../src/schema-manifest.js';
import { hashPlaintextPasswords } from '../src/hashPasswords.js';

const raw = fs.readFileSync(process.env.USERPROFILE + '/Downloads/scd-panda-1bc5a-default-rtdb-export (50).json', 'utf8');
const data = JSON.parse(raw);

const { sql, manifest, summary, fkSummary } = buildImportPlan(data);

const client = await pool.connect();
try {
  await client.query(sql);
} finally {
  client.release();
}

setManifest(manifest);
const passwordResults = await hashPlaintextPasswords(pool);

console.log('Tables:', summary.length, 'Total rows:', summary.reduce((s, t) => s + t.rows, 0));
console.log('fkSummary:', JSON.stringify(fkSummary, null, 2));
console.log('passwords:', JSON.stringify(passwordResults));

await pool.end();
