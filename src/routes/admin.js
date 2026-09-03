import { Elysia } from 'elysia';
import { pool } from '../db.js';
import { buildImportPlan, buildIncrementalImportPlan } from '../importData.js';
import { setManifest } from '../schema-manifest.js';
import { requireAdmin } from '../authMiddleware.js';
import { hashPlaintextPasswords } from '../hashPasswords.js';

export const adminRoutes = new Elysia()
  .post('/api/admin/import', async ({ headers, body, set }) => {
    requireAdmin(headers);

    const data = body?.data;
    if (!data) {
      set.status = 400;
      return { error: 'Missing "data" (the Firebase export JSON) in request body' };
    }

    const { sql, manifest, summary, fkSummary } = buildImportPlan(data);

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
      fkReferencesNotResolved: fkSummary,
    };
  })

  // Adds only the rows a newer Firebase export has that this database
  // doesn't yet (matched by each row's original Firebase key) - unlike
  // /api/admin/import, this never drops or touches anything already in
  // Postgres, so it's safe to run against a live database that's had real
  // activity (new customers, transfers, tickets) since the original cutover.
  .post('/api/admin/import-incremental', async ({ headers, body, set }) => {
    requireAdmin(headers);

    const data = body?.data;
    if (!data) {
      set.status = 400;
      return { error: 'Missing "data" (the Firebase export JSON) in request body' };
    }

    const { sql, manifest, summary, fkSummary, manifestUpdates, totalNewRows } = await buildIncrementalImportPlan(
      data,
      pool
    );

    if (totalNewRows === 0) {
      return {
        ok: true,
        totalNewRows: 0,
        summary,
        message: 'ไม่มีข้อมูลใหม่ที่ต้องเพิ่ม - ทุกแถวในไฟล์นี้มีอยู่ในฐานข้อมูลแล้ว',
      };
    }

    const client = await pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }

    // Only persist the manifest update after the SQL above actually
    // committed - if that query had thrown, nothing here would run, so the
    // on-disk/in-memory manifest never drifts from the real schema.
    setManifest(manifest);

    const passwordResults = await hashPlaintextPasswords(pool);

    return {
      ok: true,
      totalNewRows,
      summary,
      columnsAdded: manifestUpdates,
      passwordsHashed: passwordResults,
      fkReferencesNotResolved: fkSummary,
    };
  });
