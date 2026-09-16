// One-time backfill for quotation.Customer -> customers (discriminated by
// Truck, since customer ids are only unique within one of the 5 merged
// customers categories - see importData.js FK_FIELDS.quotation.Customer).
// Added to FK_FIELDS for future imports; this brings the 164 rows already
// in Postgres up to the same shape.
//
// Safe by default - prints exactly what it found and what it WOULD do
// without changing anything. Pass --apply to actually run the migration.
//
// Usage:
//   bun run scripts/backfill-quotation-customer.js            # dry run
//   bun run scripts/backfill-quotation-customer.js --apply    # actually migrate

import { pool } from '../src/db.js';
import { getManifest, setManifest } from '../src/schema-manifest.js';

const DISCRIMINATOR_MAP = { 'รถใหญ่': 'bigtruck', 'รถเล็ก': 'smalltruck' };

const apply = process.argv.includes('--apply');

function parseIdName(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d+):([\s\S]*)$/);
  if (!m) return null;
  return { id: parseInt(m[1], 10), name: m[2].trim() };
}

async function run() {
  const idMapByCategory = {};
  const { rows: customerRows } = await pool.query(
    `SELECT "category", "id", "uuid" FROM "customers" WHERE "id" IS NOT NULL`,
  );
  for (const r of customerRows) {
    (idMapByCategory[r.category] ??= {})[Number(r.id)] = r.uuid;
  }

  const { rows } = await pool.query(`SELECT "uuid", "truck", "customer" AS raw FROM "quotation"`);

  let idNameShaped = 0;
  let resolved = 0;
  const plans = rows.map((row) => {
    const parsed = parseIdName(row.raw);
    const name = parsed ? parsed.name : row.raw;
    let targetUuid = null;
    if (parsed) {
      idNameShaped++;
      const category = DISCRIMINATOR_MAP[row.truck];
      targetUuid = category ? idMapByCategory[category]?.[parsed.id] || null : null;
      if (targetUuid) resolved++;
    }
    return { uuid: row.uuid, truck: row.truck, name, targetUuid };
  });

  console.log(
    `rows: ${rows.length}, id:name-shaped: ${idNameShaped}, resolved: ${resolved}, ` +
      `unresolved (kept NULL): ${idNameShaped - resolved}, not id:name-shaped (kept as plain text in CustomerName): ${rows.length - idNameShaped}`,
  );
  const unresolvedSamples = plans.filter((p) => p.name && !p.targetUuid);
  if (unresolvedSamples.length) {
    console.log(
      '  sample rows with no match (name kept, FK left NULL):',
      unresolvedSamples.slice(0, 5).map((p) => `${p.truck}: ${p.name}`),
    );
  }

  if (!apply) {
    console.log('\nDry run only - nothing was changed. Re-run with --apply to actually migrate.');
    await pool.end();
    return;
  }

  await pool.query(`ALTER TABLE "quotation" ADD COLUMN IF NOT EXISTS "customer_name" TEXT`);
  await pool.query(`ALTER TABLE "quotation" ADD COLUMN IF NOT EXISTS "customer_fk_tmp" UUID`);

  for (const p of plans) {
    await pool.query(
      `UPDATE "quotation" SET "customer_name" = $1, "customer_fk_tmp" = $2 WHERE "uuid" = $3`,
      [p.name, p.targetUuid, p.uuid],
    );
  }

  await pool.query(`ALTER TABLE "quotation" DROP COLUMN "customer"`);
  await pool.query(`ALTER TABLE "quotation" RENAME COLUMN "customer_fk_tmp" TO "customer"`);
  await pool.query(
    `ALTER TABLE "quotation" ADD CONSTRAINT "quotation_customer_fkey" FOREIGN KEY ("customer") REFERENCES "customers" ("uuid")`,
  );

  const manifest = getManifest();
  const def = manifest.quotation;
  const col = def.columns.find((c) => c.field === 'Customer');
  if (col) col.type = 'UUID';
  if (!def.columns.some((c) => c.field === 'CustomerName')) {
    def.columns.push({ field: 'CustomerName', column: 'customer_name', type: 'TEXT' });
  }
  setManifest(manifest);

  console.log('\napplied. schema-manifest.json updated to match.');
  await pool.end();
}

run();
