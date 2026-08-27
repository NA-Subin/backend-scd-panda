const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const {
  assertValidTable,
  assertValidColumns,
  selectColumnsSql,
  columnNameForField,
} = require('../schema-manifest');
const { rowsToKeyedObject } = require('../rowShape');

const router = express.Router();

function columnTypeForField(def, field) {
  const col = def.columns.find((c) => c.field === field);
  return col ? col.type : 'TEXT';
}

function toBoundValue(value, type) {
  if (type === 'JSONB' && value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

router.get('/:table', async (req, res, next) => {
  try {
    const { table } = req.params;
    assertValidTable(table);
    const { rows } = await pool.query(`SELECT ${selectColumnsSql(table)} FROM "${table}"`);
    res.json(rowsToKeyedObject(rows));
  } catch (err) {
    next(err);
  }
});

router.get('/:table/:rowKey', async (req, res, next) => {
  try {
    const { table, rowKey } = req.params;
    assertValidTable(table);
    const { rows } = await pool.query(
      `SELECT ${selectColumnsSql(table)} FROM "${table}" WHERE "row_key" = $1`,
      [rowKey]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { row_key, ...fields } = rows[0];
    res.json(fields);
  } catch (err) {
    next(err);
  }
});

router.post('/:table', async (req, res, next) => {
  try {
    const { table } = req.params;
    const def = assertValidTable(table);
    const body = req.body || {};
    const fields = Object.keys(body).filter((f) => f !== 'row_key');
    assertValidColumns(table, fields);

    const rowKey = body.row_key || crypto.randomUUID();
    const columns = ['"row_key"', ...fields.map((f) => `"${columnNameForField(table, f)}"`)];
    const placeholders = fields.map((_, i) => `$${i + 2}`);
    const values = [rowKey, ...fields.map((f) => toBoundValue(body[f], columnTypeForField(def, f)))];

    await pool.query(
      `INSERT INTO "${table}" (${columns.join(', ')}) VALUES ($1, ${placeholders.join(', ')})`,
      values
    );
    res.status(201).json({ row_key: rowKey });
  } catch (err) {
    next(err);
  }
});

router.put('/:table/:rowKey', async (req, res, next) => {
  try {
    const { table, rowKey } = req.params;
    const def = assertValidTable(table);
    const body = req.body || {};
    const fields = Object.keys(body).filter((f) => f !== 'row_key');
    assertValidColumns(table, fields);

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    const setClauses = fields.map((f, i) => `"${columnNameForField(table, f)}" = $${i + 2}`);
    const values = [rowKey, ...fields.map((f) => toBoundValue(body[f], columnTypeForField(def, f)))];

    const result = await pool.query(
      `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE "row_key" = $1`,
      values
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:table/:rowKey', async (req, res, next) => {
  try {
    const { table, rowKey } = req.params;
    assertValidTable(table);
    const result = await pool.query(`DELETE FROM "${table}" WHERE "row_key" = $1`, [rowKey]);
    if (!result.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
