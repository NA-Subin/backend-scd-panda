// One-time backfill for report_financial.Name -> deductibleincome (the
// income/deduction category, e.g. "1:เงินเดือน" -> deductibleincome id 1,
// "เงินเดือน" - confirmed by matching real data). Added to FK_FIELDS for
// future imports; this brings the 385 rows already in Postgres up to the
// same shape.
//
// Safe by default - prints exactly what it found and what it WOULD do
// without changing anything. Pass --apply to actually run the migration.
//
// Usage:
//   bun run scripts/backfill-report-financial-name.js            # dry run
//   bun run scripts/backfill-report-financial-name.js --apply    # actually migrate

import { pool } from '../src/db.js';
import { getManifest, setManifest } from '../src/schema-manifest.js';

const apply = process.argv.includes('--apply');

function parseIdName(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d+):([\s\S]*)$/);
  if (!m) return null;
  return { id: parseInt(m[1], 10), name: m[2].trim() };
}

async function run() {
  const { rows: targetRows } = await pool.query(
    `SELECT "id", "uuid" FROM "deductibleincome" WHERE "id" IS NOT NULL`,
  );
  const idMap = {};
  for (const r of targetRows) idMap[Number(r.id)] = r.uuid;

  const { rows } = await pool.query(`SELECT "uuid", "name" AS raw FROM "report_financial"`);

  let idNameShaped = 0;
  let resolved = 0;
  const plans = rows.map((row) => {
    const parsed = parseIdName(row.raw);
    const name = parsed ? parsed.name : row.raw;
    let targetUuid = null;
    if (parsed) {
      idNameShaped++;
      targetUuid = idMap[parsed.id] || null;
      if (targetUuid) resolved++;
    }
    return { uuid: row.uuid, name, targetUuid };
  });

  console.log(
    `rows: ${rows.length}, id:name-shaped: ${idNameShaped}, resolved: ${resolved}, ` +
      `unresolved (kept NULL): ${idNameShaped - resolved}, not id:name-shaped (kept as plain text in NameName): ${rows.length - idNameShaped}`,
  );
  const unresolvedSamples = plans.filter((p) => p.name && !p.targetUuid);
  if (unresolvedSamples.length) {
    console.log('  sample rows with no match (name kept, FK left NULL):', unresolvedSamples.slice(0, 5).map((p) => p.name));
  }

  if (!apply) {
    console.log('\nDry run only - nothing was changed. Re-run with --apply to actually migrate.');
    await pool.end();
    return;
  }

  await pool.query(`ALTER TABLE "report_financial" ADD COLUMN IF NOT EXISTS "name_name" TEXT`);
  await pool.query(`ALTER TABLE "report_financial" ADD COLUMN IF NOT EXISTS "name_fk_tmp" UUID`);

  for (const p of plans) {
    await pool.query(
      `UPDATE "report_financial" SET "name_name" = $1, "name_fk_tmp" = $2 WHERE "uuid" = $3`,
      [p.name, p.targetUuid, p.uuid],
    );
  }

  await pool.query(`ALTER TABLE "report_financial" DROP COLUMN "name"`);
  await pool.query(`ALTER TABLE "report_financial" RENAME COLUMN "name_fk_tmp" TO "name"`);
  await pool.query(
    `ALTER TABLE "report_financial" ADD CONSTRAINT "report_financial_name_fkey" FOREIGN KEY ("name") REFERENCES "deductibleincome" ("uuid")`,
  );

  const manifest = getManifest();
  const def = manifest.report_financial;
  const col = def.columns.find((c) => c.field === 'Name');
  if (col) col.type = 'UUID';
  if (!def.columns.some((c) => c.field === 'NameName')) {
    def.columns.push({ field: 'NameName', column: 'name_name', type: 'TEXT' });
  }
  setManifest(manifest);

  console.log('\napplied. schema-manifest.json updated to match.');
  await pool.end();
}

run();
