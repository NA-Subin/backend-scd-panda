import { Elysia } from 'elysia';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { selectColumnsSql, assertValidColumns, columnNameForField } from '../schema-manifest.js';
import { requireAuth } from '../authMiddleware.js';

// Only officers/drivers carry User+Password columns in the source data;
// creditors never had login credentials in the original Firebase data either.
const LOGIN_TABLES = [
  { table: 'employee_officers', entityType: 'officer' },
  { table: 'employee_drivers', entityType: 'driver' },
];

// Tables account-creation is allowed to write to, and the column each one
// uses to store the bcrypt hash. employee_officers/employee_drivers are the
// two /api/auth/login reads from; truck_transport has its own login-shaped
// UserId/PassWord columns from a separate (pre-existing, unrelated to this
// migration) transport-truck credential flow.
const REGISTERABLE_TABLES = {
  employee_officers: 'Password',
  employee_drivers: 'Password',
  truck_transport: 'PassWord',
};

const ACCESS_RIGHT_FIELDS = [
  'AdminData',
  'DriverData',
  'GasStationData',
  'BasicData',
  'OprerationData',
  'FinancialData',
  'ReportData',
  'SmallTruckData',
  'BigTruckData',
];

async function findPosition(positionUuid) {
  if (!positionUuid) return null;
  const { rows } = await pool.query(
    `SELECT ${selectColumnsSql('positions')} FROM "positions" WHERE "uuid" = $1`,
    [positionUuid]
  );
  return rows[0] || null;
}

export const authRoutes = new Elysia()
  .post('/api/auth/login', async ({ body, set }) => {
    const { user, password } = body || {};
    if (!user || !password) {
      set.status = 400;
      return { error: 'user and password are required' };
    }

    let matchedUser = null;
    let entityType = null;

    for (const { table, entityType: type } of LOGIN_TABLES) {
      const { rows } = await pool.query(
        `SELECT ${selectColumnsSql(table)} FROM "${table}" WHERE "user" = $1`,
        [user]
      );
      if (rows.length && (await bcrypt.compare(password, rows[0].Password || ''))) {
        matchedUser = rows[0];
        entityType = type;
        break;
      }
    }

    if (!matchedUser) {
      set.status = 401;
      return { error: 'User หรือ Password ไม่ถูกต้อง' };
    }

    const position = await findPosition(matchedUser.Position);
    const accessRights = position
      ? ACCESS_RIGHT_FIELDS.filter((key) => position[key] === 1)
      : [];

    const { Password, ...safeUser } = matchedUser;

    const token = jwt.sign(
      { id: safeUser.id, user: safeUser.User, name: safeUser.Name, entityType, accessRights },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return { token, user: safeUser, entityType, accessRights };
  })

  .get('/api/auth/me', ({ headers }) => requireAuth(headers))

  // Re-verifies the caller's own password without issuing a new token or
  // changing anything - used as a step-up confirmation before letting an
  // already-logged-in admin into a sensitive area (e.g. the backup page),
  // so a shared/unlocked browser session alone isn't enough to get in.
  .post('/api/auth/verify-password', async ({ headers, body, set }) => {
    const payload = requireAuth(headers);
    const { password } = body || {};
    if (!password) {
      set.status = 400;
      return { error: 'password is required' };
    }

    const table = payload.entityType === 'driver' ? 'employee_drivers' : 'employee_officers';
    const { rows } = await pool.query(
      `SELECT ${selectColumnsSql(table)} FROM "${table}" WHERE "id" = $1`,
      [payload.id]
    );
    const row = rows[0];
    if (!row || !(await bcrypt.compare(password, row.Password || ''))) {
      set.status = 401;
      return { error: 'รหัสผ่านไม่ถูกต้อง' };
    }

    return { ok: true };
  })

  // Verifies the caller's current password against the bcrypt hash and
  // writes a freshly-hashed new one. Identity comes from the JWT, not the
  // request body, so a caller can only ever change their own password.
  // Only officers/drivers have login credentials (see LOGIN_TABLES above).
  .post('/api/auth/change-password', async ({ headers, body, set }) => {
    const payload = requireAuth(headers);
    const { currentPassword, newPassword } = body || {};
    if (!currentPassword || !newPassword) {
      set.status = 400;
      return { error: 'currentPassword and newPassword are required' };
    }

    const table = payload.entityType === 'driver' ? 'employee_drivers' : 'employee_officers';
    const { rows } = await pool.query(
      `SELECT ${selectColumnsSql(table)} FROM "${table}" WHERE "id" = $1`,
      [payload.id]
    );
    const row = rows[0];
    if (!row || !(await bcrypt.compare(currentPassword, row.Password || ''))) {
      set.status = 401;
      return { error: 'รหัสผ่านเดิมไม่ถูกต้อง' };
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE "${table}" SET "${columnNameForField(table, 'Password')}" = $1 WHERE "id" = $2`,
      [hashed, payload.id]
    );

    return { success: true };
  })

  // Creates a login-capable row (officer, driver, or transport truck) with
  // a bcrypt-hashed password. Replaces the old Firebase Auth
  // createUserWithEmailAndPassword() call - both /api/auth/login and the
  // transport-truck credential flow only ever compare against a bcrypt
  // hash, so any account created outside this endpoint (e.g. via the
  // generic /api/:table POST) would never be able to log in.
  // Requires an existing logged-in session - otherwise anyone on the network
  // could self-provision an officer/driver account (with whatever Position
  // they like) with no admin involved at all.
  .post('/api/auth/register', async ({ headers, body, set }) => {
    requireAuth(headers);

    const { table, fields, password } = body || {};

    const passwordField = REGISTERABLE_TABLES[table];
    if (!passwordField) {
      set.status = 400;
      return { error: 'table must be one of: ' + Object.keys(REGISTERABLE_TABLES).join(', ') };
    }
    if (!password) {
      set.status = 400;
      return { error: 'password is required' };
    }

    const record = fields || {};
    const requestedFields = Object.keys(record).filter((f) => f !== 'uuid' && f !== 'row_key' && f !== passwordField);
    assertValidColumns(table, [...requestedFields, passwordField]);

    const hashed = await bcrypt.hash(password, 10);
    const uuid = crypto.randomUUID();
    const allFields = [...requestedFields, passwordField];
    const columns = ['"uuid"', '"row_key"', ...allFields.map((f) => `"${columnNameForField(table, f)}"`)];
    const placeholders = allFields.map((_, i) => `$${i + 3}`);
    const values = [uuid, uuid, ...requestedFields.map((f) => record[f]), hashed];

    await pool.query(
      `INSERT INTO "${table}" (${columns.join(', ')}) VALUES ($1, $2, ${placeholders.join(', ')})`,
      values
    );

    set.status = 201;
    return { uuid };
  });
