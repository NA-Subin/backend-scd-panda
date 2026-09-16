import { Elysia } from 'elysia';
import { pool } from '../db.js';
import { buildImportPlan } from '../importData.js';
import { setManifest } from '../schema-manifest.js';
import { requireAdmin } from '../authMiddleware.js';
import { hashPlaintextPasswords } from '../hashPasswords.js';
import { verifyBootstrapImportPassword, resetBootstrapImportPassword } from '../bootstrapImportAccess.js';

// Whether this database already has at least one real account - i.e.
// whether the normal login flow can possibly work yet. Checked fresh
// against Postgres on every call, never cached, since this is the safety
// gate that decides whether the unauthenticated import door below is even
// reachable at all.
async function isDatabaseBootstrapped() {
  try {
    const { rows } = await pool.query('SELECT 1 FROM "employee_officers" LIMIT 1');
    return rows.length > 0;
  } catch (err) {
    // 42P01 = undefined_table - the table doesn't exist yet on a brand-new
    // database, which is exactly the "not bootstrapped" case.
    if (err.code === '42P01') return false;
    throw err;
  }
}

export const bootstrapImportRoutes = new Elysia()
  // Public - the Login page polls this to decide whether to show the
  // bootstrap-import button at all. Never reveals anything beyond a
  // boolean, and always reflects the database's real current state.
  .get('/api/bootstrap-import/status', async () => {
    return { available: !(await isDatabaseBootstrapped()) };
  })

  // Public by design (there's no account to log in with yet on a fresh
  // database - that's the whole reason this exists), but double-gated:
  // this only ever runs the import if the database genuinely doesn't have
  // a real account yet AND the caller knows the shared access code. Once
  // a single employee_officers row exists (including right after this very
  // import runs), this endpoint refuses every further request - it is not
  // a permanent unauthenticated way to overwrite a live database.
  .post('/api/bootstrap-import', async ({ body, set }) => {
    if (await isDatabaseBootstrapped()) {
      set.status = 409;
      return { error: 'ฐานข้อมูลมีข้อมูลอยู่แล้ว ไม่สามารถนำเข้าข้อมูลผ่านหน้านี้ได้อีก' };
    }

    const { code, data } = body || {};
    const codeOk = await verifyBootstrapImportPassword(code);
    if (!codeOk) {
      set.status = 401;
      return { error: 'รหัสไม่ถูกต้อง' };
    }

    if (!data) {
      set.status = 400;
      return { error: 'Missing "data" (the Firebase export JSON) in request body' };
    }

    const { sql, manifest, summary, fkSummary, warnings } = buildImportPlan(data);

    const client = await pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }

    setManifest(manifest);

    const passwordResults = await hashPlaintextPasswords(pool);

    return {
      ok: true,
      tables: summary.length,
      totalRows: summary.reduce((sum, t) => sum + t.rows, 0),
      summary,
      passwordsHashed: passwordResults,
      fkReferencesNotResolved: fkSummary,
      warnings,
    };
  })

  // Admin-gated (unlike the two routes above) - by the time anyone would
  // use this, a real account already exists, so normal auth applies.
  .post('/api/admin/bootstrap-import-access/reset', async ({ headers, body, set }) => {
    requireAdmin(headers);
    const { oldPassword, newPassword } = body || {};
    if (!newPassword) {
      set.status = 400;
      return { error: 'newPassword is required' };
    }
    await resetBootstrapImportPassword(oldPassword, newPassword);
    return { ok: true };
  });
