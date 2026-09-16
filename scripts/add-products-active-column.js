// One-time schema change for the (currently unused) `products` table: adds
// IsActive (boolean - whether this fuel product is currently offered) and
// NameTH (Thai display name), so a future switch from the hardcoded
// per-product frontend lists to a DB-driven list has real data to read from.
// No frontend consumer is being wired up yet - this only prepares the table.
//
// Safe by default - prints exactly what it would do without changing
// anything. Pass --apply to actually run the migration.
//
// Usage:
//   bun run scripts/add-products-active-column.js            # dry run
//   bun run scripts/add-products-active-column.js --apply    # actually migrate

import { pool } from '../src/db.js';
import { getManifest, setManifest } from '../src/schema-manifest.js';

const apply = process.argv.includes('--apply');

// Thai display names for the 10 existing rows. G95/B95/B7(D)/G91/E20/PWD
// match the names already hardcoded in QuotationDetail.js; the rest
// (B10/B20/E85/ULG95, which aren't in that list) use the same naming style.
const NAME_TH = {
  G95: 'แก๊สโซฮอล์ 95',
  G91: 'แก๊สโซฮอล์ 91',
  'B7(D)': 'ดีเซล B7',
  B95: 'เบนซิน 95',
  B10: 'ดีเซล B10',
  B20: 'ดีเซล B20',
  E20: 'แก๊สโซฮอล์ E20',
  E85: 'แก๊สโซฮอล์ E85',
  PWD: 'ดีเซลพรีเมียม (Premium Diesel)',
  ULG95: 'เบนซิน 95 (ULG)',
};

async function run() {
  const { rows } = await pool.query(`SELECT "uuid", "product_name" FROM "products" ORDER BY "row_key"::int`);

  console.log(`products rows: ${rows.length}`);
  const plans = rows.map((r) => ({ uuid: r.uuid, product_name: r.product_name, name_th: NAME_TH[r.product_name] || null }));
  const missing = plans.filter((p) => !p.name_th);
  if (missing.length) {
    console.log('  no Thai name mapped for:', missing.map((p) => p.product_name));
  }
  plans.forEach((p) => console.log(`  ${p.product_name} -> ${p.name_th || '(none)'}`));

  if (!apply) {
    console.log('\nDry run only - nothing was changed. Re-run with --apply to actually migrate.');
    await pool.end();
    return;
  }

  await pool.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "name_th" TEXT`);
  await pool.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true`);

  for (const p of plans) {
    if (p.name_th) {
      await pool.query(`UPDATE "products" SET "name_th" = $1 WHERE "uuid" = $2`, [p.name_th, p.uuid]);
    }
  }

  const manifest = getManifest();
  const def = manifest.products;
  if (!def.columns.some((c) => c.field === 'NameTH')) {
    def.columns.push({ field: 'NameTH', column: 'name_th', type: 'TEXT' });
  }
  if (!def.columns.some((c) => c.field === 'IsActive')) {
    def.columns.push({ field: 'IsActive', column: 'is_active', type: 'BOOLEAN' });
  }
  setManifest(manifest);

  console.log('\napplied. schema-manifest.json updated to match.');
  await pool.end();
}

run();
