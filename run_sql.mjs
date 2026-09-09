// Alternative to running SQL files via `psql` on the command line - uses the
// same `pg` package and connection settings the backend itself uses (reads
// backend/.env), so it works even when psql isn't on PATH or won't run.
//
// Usage (from inside the backend folder):
//   node run_sql.mjs sql/add_admin_position_flag.sql

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) loadEnvFile(envPath);

const sqlFileArg = process.argv[2];
if (!sqlFileArg) {
  console.error('Usage: node run_sql.mjs <path-to-sql-file>');
  process.exit(1);
}

const sqlPath = path.isAbsolute(sqlFileArg) ? sqlFileArg : path.join(process.cwd(), sqlFileArg);
if (!fs.existsSync(sqlPath)) {
  console.error('SQL file not found:', sqlPath);
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, 'utf8');

const client = new Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  options: `-c search_path=${process.env.PGSCHEMA}`,
});

(async () => {
  console.log(`Connecting to ${process.env.PGDATABASE} at ${process.env.PGHOST}:${process.env.PGPORT} ...`);
  await client.connect();
  console.log(`Running ${sqlPath} ...`);
  try {
    const result = await client.query(sql);
    // Multi-statement scripts return an array of results from node-postgres.
    const results = Array.isArray(result) ? result : [result];
    for (const r of results) {
      console.log(r.command, r.rowCount != null ? `(${r.rowCount} rows)` : '');
    }
    console.log('\nDone - script completed successfully.');
  } catch (err) {
    console.error('\nSQL FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
