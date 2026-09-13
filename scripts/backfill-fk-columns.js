// One-time backfill for 3 "<id>:<name>" fields that were stored as plain
// TEXT instead of being split into a real UUID FK + "{Field}Name" companion
// column, the way every other id:name field in the system already is (see
// importData.js FK_FIELDS). These 3 were missed by the original migration
// and have just been added to FK_FIELDS for future imports - this script
// brings the rows already sitting in Postgres up to that same shape, since
// adding to FK_FIELDS only affects imports that happen from now on.
//
// Values that AREN'T "<id>:<name>" shaped (blank, or plain text with no id
// prefix - both occur in the real data, e.g. truck_small.Driver has rows
// literally saying "ไม่มี") are preserved as-is in the new Name column with
// the FK left NULL - nothing is dropped silently, matching how a normal
// import already treats an unparseable id:name field (see importData.js's
// appendInsertsAndConstraints / isFkNameFor handling).
//
// Safe by default - prints exactly what it found and what it WOULD do
// without changing anything. Pass --apply to actually run the migration.
//
// Usage:
//   bun run scripts/backfill-fk-columns.js            # dry run
//   bun run scripts/backfill-fk-columns.js --apply    # actually migrate

import { pool } from '../src/db.js';
import { getManifest, setManifest } from '../src/schema-manifest.js';

const MIGRATIONS = [
  { table: 'employee_officers', field: 'GasStation', column: 'gas_station', target: 'depot_gas_stations' },
  { table: 'report_invoice', field: 'Registration', column: 'registration', target: 'truck_registration' },
  { table: 'truck_small', field: 'Driver', column: 'driver', target: 'employee_drivers' },
];

const apply = process.argv.includes('--apply');

function parseIdName(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d+):([\s\S]*)$/);
  if (!m) return null;
  return { id: parseInt(m[1], 10), name: m[2].trim() };
}

async function loadIdMap(target) {
  const { rows } = await pool.query(`SELECT "id", "uuid" FROM "${target}" WHERE "id" IS NOT NULL`);
  const map = {};
  for (const r of rows) map[Number(r.id)] = r.uuid;
  return map;
}

async function run() {
  const manifest = getManifest();

  for (const { table, field, column, target } of MIGRATIONS) {
    console.log(`\n=== ${table}.${column} (${field}) -> ${target} ===`);
    const idMap = await loadIdMap(target);
    const { rows } = await pool.query(`SELECT "uuid", "${column}" AS raw FROM "${table}"`);

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
        `unresolved (kept NULL): ${idNameShaped - resolved}, not id:name-shaped (kept as plain text in the Name column): ${rows.length - idNameShaped}`
    );
    const unresolvedSamples = plans.filter((p) => p.name && !p.targetUuid);
    if (unresolvedSamples.length) {
      console.log('  sample rows with no FK match (name kept, FK left NULL):', unresolvedSamples.slice(0, 5).map((p) => p.name));
    }

    if (!apply) continue;

    const nameColumn = `${column}_name`;
    const tmpColumn = `${column}_fk_tmp`;
    await pool.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${nameColumn}" TEXT`);
    await pool.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${tmpColumn}" UUID`);

    for (const p of plans) {
      await pool.query(
        `UPDATE "${table}" SET "${nameColumn}" = $1, "${tmpColumn}" = $2 WHERE "uuid" = $3`,
        [p.name, p.targetUuid, p.uuid]
      );
    }

    await pool.query(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    await pool.query(`ALTER TABLE "${table}" RENAME COLUMN "${tmpColumn}" TO "${column}"`);
    await pool.query(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${column}_fkey" FOREIGN KEY ("${column}") REFERENCES "${target}" ("uuid")`
    );

    const def = manifest[table];
    const col = def.columns.find((c) => c.field === field);
    if (col) col.type = 'UUID';
    const nameField = `${field}Name`;
    if (!def.columns.some((c) => c.field === nameField)) {
      def.columns.push({ field: nameField, column: nameColumn, type: 'TEXT' });
    }

    console.log('  applied.');
  }

  if (apply) {
    setManifest(manifest);
    console.log('\nschema-manifest.json updated to match.');
  } else {
    console.log('\nDry run only - nothing was changed. Re-run with --apply to actually migrate.');
  }
  await pool.end();
}

run();
