import { Elysia } from 'elysia';
import { pool } from '../db.js';
import { BASIC_DATA_MAP, CATEGORY_FILTERED_KEYS, selectColumnsSql } from '../schema-manifest.js';
import { rowsToKeyedObject } from '../rowShape.js';
import { requireAuth } from '../authMiddleware.js';

export const basicDataRoutes = new Elysia().get('/api/basic-data', async ({ headers }) => {
  requireAuth(headers);

  const plainResults = await Promise.all(
    Object.entries(BASIC_DATA_MAP).map(async ([key, table]) => {
      const { rows } = await pool.query(`SELECT ${selectColumnsSql(table)} FROM "${table}"`);
      return [key, rowsToKeyedObject(rows)];
    })
  );

  // The 5 customer categories share one underlying table now - fetch it once
  // and split by Category in JS instead of running 5 separate queries.
  const categoryTables = new Set(Object.values(CATEGORY_FILTERED_KEYS).map((c) => c.table));
  const categoryRowsByTable = Object.fromEntries(
    await Promise.all(
      [...categoryTables].map(async (table) => {
        const { rows } = await pool.query(`SELECT ${selectColumnsSql(table)} FROM "${table}"`);
        return [table, rows];
      })
    )
  );
  const categoryResults = Object.entries(CATEGORY_FILTERED_KEYS).map(([key, { table, category }]) => {
    const rows = categoryRowsByTable[table].filter((row) => row.Category === category);
    return [key, rowsToKeyedObject(rows)];
  });

  return Object.fromEntries([...plainResults, ...categoryResults]);
});
