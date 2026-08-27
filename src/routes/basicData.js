import { Elysia } from 'elysia';
import { pool } from '../db.js';
import { BASIC_DATA_MAP, selectColumnsSql } from '../schema-manifest.js';
import { rowsToKeyedObject } from '../rowShape.js';

export const basicDataRoutes = new Elysia().get('/api/basic-data', async () => {
  const keys = Object.keys(BASIC_DATA_MAP);
  const results = await Promise.all(
    keys.map(async (key) => {
      const table = BASIC_DATA_MAP[key];
      const { rows } = await pool.query(`SELECT ${selectColumnsSql(table)} FROM "${table}"`);
      return [key, rowsToKeyedObject(rows)];
    })
  );
  return Object.fromEntries(results);
});
