const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { selectColumnsSql } = require('../schema-manifest');
const { verifyToken } = require('../authMiddleware');

const router = express.Router();

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

async function findPosition(positionField) {
  if (!positionField) return null;
  const positionId = Number(String(positionField).split(':')[0]);
  if (Number.isNaN(positionId)) return null;
  const { rows } = await pool.query(
    `SELECT ${selectColumnsSql('positions')} FROM "positions" WHERE "id" = $1`,
    [positionId]
  );
  return rows[0] || null;
}

router.post('/login', async (req, res, next) => {
  try {
    const { user, password } = req.body || {};
    if (!user || !password) {
      return res.status(400).json({ error: 'user and password are required' });
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
      return res.status(401).json({ error: 'User หรือ Password ไม่ถูกต้อง' });
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

    res.json({ token, user: safeUser, entityType, accessRights });
  } catch (err) {
    next(err);
  }
});

router.get('/me', verifyToken, (req, res) => {
  res.json(req.user);
});

module.exports = router;
