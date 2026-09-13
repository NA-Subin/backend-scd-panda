// One-time bootstrap for a brand-new, completely empty database: builds the
// schema and imports a Firebase Realtime Database export directly against
// the pool, bypassing the HTTP API entirely. This is deliberate - the
// /api/admin/import endpoint requires an admin JWT, but a fresh database has
// no accounts to log in with yet (nothing to grant that JWT from), so this
// script is the only way to get the first rows in. Run it once, then start
// the server normally - every login/import after that goes through the
// regular authenticated API.
//
// Usage: bun run scripts/bootstrap-uuid-import.js <path-to-firebase-export.json>

import fs from 'fs';
import path from 'path';
import { pool } from '../src/db.js';
import { buildImportPlan } from '../src/importData.js';
import { setManifest } from '../src/schema-manifest.js';
import { hashPlaintextPasswords } from '../src/hashPasswords.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: bun run scripts/bootstrap-uuid-import.js <path-to-firebase-export.json>');
  process.exit(1);
}

const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
if (!fs.existsSync(resolvedPath)) {
  console.error('File not found:', resolvedPath);
  process.exit(1);
}

const raw = fs.readFileSync(resolvedPath, 'utf8');
const data = JSON.parse(raw);

const { sql, manifest, summary, fkSummary, warnings } = buildImportPlan(data);

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
if (warnings.length) {
  console.warn('\n⚠ Warnings:');
  for (const w of warnings) console.warn(' -', w);
}

await pool.end();
