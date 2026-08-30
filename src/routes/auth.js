import { Elysia } from 'elysia';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { selectColumnsSql } from '../schema-manifest.js';
import { requireAuth } from '../authMiddleware.js';

// Only officers/drivers carry User+Password columns in the source data;
// creditors never had login credentials in the original Firebase data either.
const LOGIN_TABLES = [
  { table: 'employee_officers', entityType: 'officer' },
  { table: 'employee_drivers', entityType: 'driver' },
];

const ACCESS_RIGHT_FIELDS = [
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

  .get('/api/auth/me', ({ headers }) => requireAuth(headers));
