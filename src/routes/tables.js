import { Elysia } from 'elysia';
import { pool } from '../db.js';
import {
  assertValidTable,
  assertValidColumns,
  selectColumnsSql,
  columnNameForField,
} from '../schema-manifest.js';
import { rowsToKeyedObject } from '../rowShape.js';

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

export const tablesRoutes = new Elysia()
  .get('/api/:table', async ({ params: { table } }) => {
    assertValidTable(table);
    const { rows } = await pool.query(`SELECT ${selectColumnsSql(table)} FROM "${table}"`);
    return rowsToKeyedObject(rows);
  })

  .get('/api/:table/:rowKey', async ({ params: { table, rowKey }, set }) => {
    assertValidTable(table);
    const { rows } = await pool.query(
      `SELECT ${selectColumnsSql(table)} FROM "${table}" WHERE "row_key" = $1`,
      [rowKey]
    );
    if (!rows.length) {
      set.status = 404;
      return { error: 'Not found' };
    }
    const { row_key, ...fields } = rows[0];
    return fields;
  })

  .post('/api/:table', async ({ params: { table }, body, set }) => {
    const def = assertValidTable(table);
    const record = body || {};
    const fields = Object.keys(record).filter((f) => f !== 'row_key');
    assertValidColumns(table, fields);

    const rowKey = record.row_key || crypto.randomUUID();
    const columns = ['"row_key"', ...fields.map((f) => `"${columnNameForField(table, f)}"`)];
    const placeholders = fields.map((_, i) => `$${i + 2}`);
    const values = [rowKey, ...fields.map((f) => toBoundValue(record[f], columnTypeForField(def, f)))];

    await pool.query(
      `INSERT INTO "${table}" (${columns.join(', ')}) VALUES ($1, ${placeholders.join(', ')})`,
      values
    );
    set.status = 201;
    return { row_key: rowKey };
  })

  .put('/api/:table/:rowKey', async ({ params: { table, rowKey }, body, set }) => {
    const def = assertValidTable(table);
    const record = body || {};
    const fields = Object.keys(record).filter((f) => f !== 'row_key');
    assertValidColumns(table, fields);

    if (!fields.length) {
      set.status = 400;
      return { error: 'No fields to update' };
    }

    const setClauses = fields.map((f, i) => `"${columnNameForField(table, f)}" = $${i + 2}`);
    const values = [rowKey, ...fields.map((f) => toBoundValue(record[f], columnTypeForField(def, f)))];

    const result = await pool.query(
      `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE "row_key" = $1`,
      values
    );
    if (!result.rowCount) {
      set.status = 404;
      return { error: 'Not found' };
    }
    return { ok: true };
  })

  .delete('/api/:table/:rowKey', async ({ params: { table, rowKey }, set }) => {
    assertValidTable(table);
    const result = await pool.query(`DELETE FROM "${table}" WHERE "row_key" = $1`, [rowKey]);
    if (!result.rowCount) {
      set.status = 404;
      return { error: 'Not found' };
    }
    return { ok: true };
  });
