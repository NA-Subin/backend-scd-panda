import bcrypt from 'bcryptjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A single shared secret gating the login-page bootstrap-import door,
// independent of any real account (there may not be one yet - see
// routes/bootstrapImport.js) - defaults to "ChangeMe123!" the first time
// it's read, and any admin can reset it (old password required) once the
// database has real data, from the Setting page. Same file-based approach
// as backupAccess.js, and for the same reason: this has to work even when
// the database has no tables at all yet, so it can't live in Postgres.
const ACCESS_FILE = path.join(process.cwd(), 'bootstrap-import-access.json');
const DEFAULT_PASSWORD = 'ChangeMe123!';

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

export async function verifyBootstrapImportPassword(password) {
  const { passwordHash } = await ensureAccessFile();
  return bcrypt.compare(password || '', passwordHash);
}

export async function resetBootstrapImportPassword(oldPassword, newPassword) {
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
