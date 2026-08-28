import { Elysia } from 'elysia';
import { pool } from '../db.js';
import { buildImportPlan } from '../importData.js';
import { setManifest } from '../schema-manifest.js';
import { requireAuth } from '../authMiddleware.js';
import { hashPlaintextPasswords } from '../hashPasswords.js';

export const adminRoutes = new Elysia().post('/api/admin/import', async ({ headers, body, set }) => {
  requireAuth(headers);

  const data = body?.data;
  if (!data) {
    set.status = 400;
    return { error: 'Missing "data" (the Firebase export JSON) in request body' };
  }

  const { sql, manifest, summary } = buildImportPlan(data);

  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }

  setManifest(manifest);

  // The re-imported officer/driver rows carry plaintext passwords (that's
  // what's in the Firebase export) - hash them immediately so login keeps
  // working with the existing JWT + bcrypt auth flow.
  const passwordResults = await hashPlaintextPasswords(pool);

  return {
    ok: true,
    tables: summary.length,
    totalRows: summary.reduce((sum, t) => sum + t.rows, 0),
    summary,
    passwordsHashed: passwordResults,
  };
});
