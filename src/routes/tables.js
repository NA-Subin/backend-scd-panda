import { Elysia } from 'elysia';
import { pool } from '../db.js';
import {
  assertValidTable,
  assertValidColumns,
  selectColumnsSql,
  columnNameForField,
} from '../schema-manifest.js';
import { rowsToKeyedObject } from '../rowShape.js';
import { requireAuth } from '../authMiddleware.js';

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
  .get('/api/:table', async ({ params: { table }, headers }) => {
    requireAuth(headers);
    assertValidTable(table);
    const { rows } = await pool.query(`SELECT ${selectColumnsSql(table)} FROM "${table}"`);
    return rowsToKeyedObject(rows);
  })

  .get('/api/:table/:uuid', async ({ params: { table, uuid }, headers, set }) => {
    requireAuth(headers);
    assertValidTable(table);
    const { rows } = await pool.query(
      `SELECT ${selectColumnsSql(table)} FROM "${table}" WHERE "uuid" = $1`,
      [uuid]
    );
    if (!rows.length) {
      set.status = 404;
      return { error: 'Not found' };
    }
    const { uuid: _uuid, row_key, ...fields } = rows[0];
    return fields;
  })

  .post('/api/:table', async ({ params: { table }, body, headers, set }) => {
    requireAuth(headers);
    const def = assertValidTable(table);
    const record = body || {};
    const fields = Object.keys(record).filter((f) => f !== 'uuid' && f !== 'row_key');
    assertValidColumns(table, fields);

    const uuid = crypto.randomUUID();
    const columns = ['"uuid"', '"row_key"', ...fields.map((f) => `"${columnNameForField(table, f)}"`)];
    const placeholders = fields.map((_, i) => `$${i + 3}`);
    const values = [uuid, record.row_key || uuid, ...fields.map((f) => toBoundValue(record[f], columnTypeForField(def, f)))];

    await pool.query(
      `INSERT INTO "${table}" (${columns.join(', ')}) VALUES ($1, $2, ${placeholders.join(', ')})`,
      values
    );
    set.status = 201;
    return { uuid };
  })

  .put('/api/:table/:uuid', async ({ params: { table, uuid }, body, headers, set }) => {
    requireAuth(headers);
    const def = assertValidTable(table);
    const record = body || {};
    const fields = Object.keys(record).filter((f) => f !== 'uuid' && f !== 'row_key');
    assertValidColumns(table, fields);

    if (!fields.length) {
      set.status = 400;
      return { error: 'No fields to update' };
    }

    const setClauses = fields.map((f, i) => `"${columnNameForField(table, f)}" = $${i + 2}`);
    const values = [uuid, ...fields.map((f) => toBoundValue(record[f], columnTypeForField(def, f)))];

    const result = await pool.query(
      `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE "uuid" = $1`,
      values
    );
    if (!result.rowCount) {
      set.status = 404;
      return { error: 'Not found' };
    }
    return { ok: true };
  })

  .delete('/api/:table/:uuid', async ({ params: { table, uuid }, headers, set }) => {
    requireAuth(headers);
    assertValidTable(table);
    const result = await pool.query(`DELETE FROM "${table}" WHERE "uuid" = $1`, [uuid]);
    if (!result.rowCount) {
      set.status = 404;
      return { error: 'Not found' };
    }
    return { ok: true };
  });
