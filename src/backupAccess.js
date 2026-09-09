import bcrypt from 'bcryptjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A single shared secret gating the backup page, independent of anyone's
// personal login password - defaults to "admin" the first time it's read,
// and any admin can reset it (old password required) from the backup page.
// Stored as its own JSON file rather than a DB table since it's one global
// value, not per-row app data.
const ACCESS_FILE = path.join(process.cwd(), 'backup-access.json');
const DEFAULT_PASSWORD = 'admin';

async function readAccessFile() {
  try {
    const raw = await readFile(ACCESS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function ensureAccessFile() {
  const existing = await readAccessFile();
  if (existing?.passwordHash) return existing;

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  const created = { passwordHash };
  await writeFile(ACCESS_FILE, JSON.stringify(created, null, 2), 'utf8');
  return created;
}

export async function verifyBackupPassword(password) {
  const { passwordHash } = await ensureAccessFile();
  return bcrypt.compare(password || '', passwordHash);
}

export async function resetBackupPassword(oldPassword, newPassword) {
  const { passwordHash } = await ensureAccessFile();
  const oldMatches = await bcrypt.compare(oldPassword || '', passwordHash);
  if (!oldMatches) {
    const err = new Error('รหัสผ่านเดิมไม่ถูกต้อง');
    err.status = 401;
    throw err;
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await writeFile(ACCESS_FILE, JSON.stringify({ passwordHash: newHash }, null, 2), 'utf8');
}
