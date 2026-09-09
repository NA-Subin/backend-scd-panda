import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export const BACKUP_DIR = path.join(process.cwd(), 'backups');
await mkdir(BACKUP_DIR, { recursive: true });

const RETENTION_DAYS = 30;

// pg_dump.exe isn't always on PATH (same issue this project already hit with
// psql.exe) - PG_DUMP_PATH in .env can point at the full path if needed,
// e.g. "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe".
const PG_DUMP_PATH = process.env.PG_DUMP_PATH || 'pg_dump';

function backupFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `scd_panda_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.sql`
  );
}

// Runs a plain-text pg_dump of the app's schema to a timestamped .sql file
// in BACKUP_DIR. Plain SQL (not pg_dump's custom -F c format) so a backup
// can be restored with nothing but psql/run_sql.mjs, consistent with how
// this project already runs SQL files by hand.
export function runBackup() {
  return new Promise((resolve, reject) => {
    const filename = backupFilename();
    const filePath = path.join(BACKUP_DIR, filename);

    const args = [
      '-h', process.env.PGHOST,
      '-p', process.env.PGPORT,
      '-U', process.env.PGUSER,
      '-d', process.env.PGDATABASE,
      '-n', process.env.PGSCHEMA,
      '--no-owner',
      '--no-privileges',
      '-f', filePath,
    ];

    const child = spawn(PG_DUMP_PATH, args, {
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD },
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(
        new Error(
          `ไม่พบ pg_dump ("${PG_DUMP_PATH}") - ตั้งค่า PG_DUMP_PATH ใน backend/.env ให้ชี้ไปที่ path เต็มของ pg_dump.exe: ${err.message}`
        )
      );
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`pg_dump ล้มเหลว (exit code ${code}): ${stderr || 'ไม่มีรายละเอียดเพิ่มเติม'}`));
        return;
      }
      resolve({ filename, path: filePath });
    });
  });
}

export async function listBackups() {
  const files = await readdir(BACKUP_DIR);
  const sqlFiles = files.filter((f) => f.endsWith('.sql'));
  const details = await Promise.all(
    sqlFiles.map(async (filename) => {
      const s = await stat(path.join(BACKUP_DIR, filename));
      return { filename, size: s.size, createdAt: s.birthtime ?? s.mtime };
    })
  );
  return details.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Keeps only the last RETENTION_DAYS worth of backups - deletes anything
// older, run automatically after every scheduled/manual backup.
export async function pruneOldBackups() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = await listBackups();
  const removed = [];
  for (const f of files) {
    if (new Date(f.createdAt).getTime() < cutoff) {
      await unlink(path.join(BACKUP_DIR, f.filename));
      removed.push(f.filename);
    }
  }
  return removed;
}

export async function deleteBackup(filename) {
  await unlink(path.join(BACKUP_DIR, filename));
}
