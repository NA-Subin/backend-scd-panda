import { Elysia } from 'elysia';
import { pool } from '../db.js';
import {
  assertValidTable,
  assertValidColumns,
  selectColumnsSql,
  columnNameForField,
} from '../schema-manifest.js';
import { rowsToKeyedObject } from '../rowShape.js';
import { requireAuth, requireAdmin } from '../authMiddleware.js';

function columnTypeForField(def, field) {
  const col = def.columns.find((c) => c.field === field);
  return col ? col.type : 'TEXT';
}

// Editing an EXISTING position's permission flags can grant/revoke admin
// rights, and editing/creating company records changes the legal entity
// printed on every invoice - both restricted to admin here, rather than
// relying on the Setting page's own tab visibility alone. Reads are
// unaffected - other pages (Navbar, Choose, printing) legitimately need to
// read these tables for every user.
const ADMIN_ONLY_MODIFY_TABLES = new Set(['positions', 'company', 'company_history']);

// Creating a brand-new position is left open - employee/InsertEmployee.js
// also creates positions inline while onboarding a new employee, and that
// path never includes AdminData in its payload, so it can't itself grant
// admin rights. Company records, on the other hand, are only ever created
// from Setting.js, so creating those is admin-only too.
const ADMIN_ONLY_CREATE_TABLES = new Set(['company', 'company_history']);

function requireAuthForCreate(table, headers) {
  if (ADMIN_ONLY_CREATE_TABLES.has(table)) {
    requireAdmin(headers);
  } else {
    requireAuth(headers);
  }
}

function requireAuthForModify(table, headers) {
  if (ADMIN_ONLY_MODIFY_TABLES.has(table)) {
    requireAdmin(headers);
  } else {
    requireAuth(headers);
  }
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
    requireAuthForCreate(table, headers);
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
    requireAuthForModify(table, headers);
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
    requireAuthForModify(table, headers);
    assertValidTable(table);
    const result = await pool.query(`DELETE FROM "${table}" WHERE "uuid" = $1`, [uuid]);
    if (!result.rowCount) {
      set.status = 404;
      return { error: 'Not found' };
    }
    return { ok: true };
  });
