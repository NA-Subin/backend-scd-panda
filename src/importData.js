import { getManifest } from './schema-manifest.js';

// Converts a Firebase Realtime Database export (parsed JSON) into SQL that
// drops and recreates all derived tables, then returns that SQL plus a fresh
// schema manifest (column name mapping) and a row-count summary.
//
// This is the same logic used to build the original sql/scd-panda-dump.sql,
// plus two additions on top of the raw Firebase shape:
//
// 1. Every row gets a freshly generated UUID as its real primary key (instead
//    of the Firebase key or the human "id" number). Those aren't safe to rely
//    on across sources - two independent Firebase projects/branches can both
//    hand out row_key "5" or id=5 for completely different records, so if
//    data from multiple sources is ever combined later, colliding on those
//    would silently merge or overwrite unrelated rows. A UUID generated here
//    doesn't have that problem. The original Firebase key is kept alongside
//    as a plain "row_key" column for traceability, just no longer the PK.
//
// 2. A curated set of "id:name" fields (a workaround Firebase forced since it
//    has no real foreign keys) get split into a real UUID FK column + a
//    companion "{Field}Name" text column. The mapping below was derived by
//    cross-checking every "id:name"-shaped field in the real export against
//    every candidate table's identifying text field - fields that are
//    genuinely polymorphic (can point at different tables depending on the
//    row, e.g. TicketName/Customer/Order1-9/Ticket1-27) or that had no
//    reliable single target were deliberately left alone.

const NAMESPACE_NODES = new Set(['customers', 'depot', 'employee', 'report', 'truck']);

// The 5 customers/* subnodes are merged into one "customers" table (tagged
// with a Category column) instead of 5 separate tables, so order.TicketName
// and tickets.TicketName can point at a single real FK target - Postgres
// can't constrain one column against multiple tables. Ids are only unique
// within one of these subnodes, not across all 5 - see discriminatorField
// below for how that's resolved.
const CUSTOMER_CATEGORIES = new Set(['bigtruck', 'smalltruck', 'gasstations', 'tickets', 'transports']);
// Duplicate lowercase-cased fields (companyName/creditTime) that shadow the
// real CompanyName/CreditTime fields on 3 of the 5 tables - no frontend code
// reads them, dropped during the merge rather than carried forward twice.
const CUSTOMER_MERGE_DROP_FIELDS = ['companyName', 'creditTime'];

// A single field can point at a different target row depending on another
// field on the same record (TicketName's numeric id is only meaningful
// together with CustomerType - "2" means something different for an oil
// ticket than for a gas-station ticket). discriminatorField names that other
// field; discriminatorMap resolves its value to the target row's Category.
const TICKET_NAME_DISCRIMINATOR = {
  target: 'customers',
  discriminatorField: 'CustomerType',
  discriminatorMap: {
    'ตั๋วน้ำมัน': 'tickets',
    'ตั๋วปั้ม': 'gasstations',
    'ตั๋วรับจ้างขนส่ง': 'transports',
    'ตั๋วรถใหญ่': 'bigtruck',
    'ตั๋วรถเล็ก': 'smalltruck',
  },
};

// tableName -> { fieldName -> { target: tableName } }
const FK_FIELDS = {
  customers: { Company: { target: 'company' } },
  employee_drivers: { Position: { target: 'positions' }, Registration: { target: 'truck_registration' } },
  employee_officers: { Position: { target: 'positions' } },
  inspection: { Employee: { target: 'employee_drivers' }, employee: { target: 'employee_drivers' } },
  invoice: {
    Transport: { target: 'company' },
    // Same polymorphic id as order.TicketName/tickets.TicketName, but keyed
    // off TicketType instead of CustomerType - the two fields hold the same
    // 5 Thai strings, just named differently on this table.
    TicketName: {
      target: 'customers',
      discriminatorField: 'TicketType',
      discriminatorMap: TICKET_NAME_DISCRIMINATOR.discriminatorMap,
    },
  },
  order: {
    Driver: { target: 'employee_drivers' },
    Registration: { target: 'truck_registration' },
    TicketName: TICKET_NAME_DISCRIMINATOR,
  },
  quotation: { Company: { target: 'company' }, Employee: { target: 'employee_officers' } },
  report_financial: {
    Driver: { target: 'employee_drivers' },
    RegHead: { target: 'truck_registration' },
    RegTail: { target: 'truck_registration_tail' },
  },
  report_invoice: {
    // Misleadingly named in the source data - verified against real content.
    Bank: { target: 'expenseitems' },
    Company: { target: 'companypayment' },
  },
  tickets: {
    Driver: { target: 'employee_drivers' },
    Registration: { target: 'truck_registration' },
    TicketName: TICKET_NAME_DISCRIMINATOR,
  },
  transfermoney: {
    BankName: { target: 'banks' },
    Transport: { target: 'company' },
    // Same polymorphic id as order.TicketName/tickets.TicketName, but keyed
    // off TicketType instead of CustomerType - the two fields hold the same
    // 5 Thai strings, just named differently on this table.
    TicketName: {
      target: 'customers',
      discriminatorField: 'TicketType',
      discriminatorMap: TICKET_NAME_DISCRIMINATOR.discriminatorMap,
    },
  },
  trip: { Driver: { target: 'employee_drivers' }, Registration: { target: 'truck_registration' } },
  truck_registration: {
    Driver: { target: 'employee_drivers' },
    RegTail: { target: 'truck_registration_tail' },
    Company: { target: 'company' },
  },
  truck_registration_tail: { Company: { target: 'company' } },
  truck_small: { Company: { target: 'company' } },
  truck_transport: { Company: { target: 'company' } },
  depot_gas_stations: { Stock: { target: 'depot_stock' } },
};

function toSnakeCase(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function quoteIdent(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

function escapeText(str) {
  return str.replace(/'/g, "''");
}

function parseIdName(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d+):([\s\S]*)$/);
  if (!m) return null;
  return { id: parseInt(m[1], 10), name: m[2].trim() };
}

function classifyColumns(tableName, rows) {
  const fieldTypes = {};
  const fieldHasObject = {};
  const fieldOrder = [];
  const fkFields = FK_FIELDS[tableName] || {};

  for (const { record } of rows) {
    for (const field of Object.keys(record)) {
      if (!(field in fieldTypes)) {
        fieldTypes[field] = new Set();
        fieldHasObject[field] = false;
        fieldOrder.push(field);
      }
      const v = record[field];
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') fieldHasObject[field] = true;
      else fieldTypes[field].add(typeof v);
    }
  }

  const usedNames = new Set();
  const fieldSet = new Set(fieldOrder);
  const columns = [];

  for (const field of fieldOrder) {
    if (fkFields[field]) {
      const fkConfig = fkFields[field];
      let idColumn = toSnakeCase(field);
      if (usedNames.has(idColumn)) {
        let n = 2;
        while (usedNames.has(`${idColumn}_${n}`)) n++;
        idColumn = `${idColumn}_${n}`;
      }
      // A handful of tables already have a genuine, unrelated field named
      // "{Field}Name" (e.g. customers_bigtruck.CompanyName is the customer's
      // OWN company name, nothing to do with the Company FK) - don't shadow it.
      const nameField = fieldSet.has(`${field}Name`) ? `${field}RefName` : `${field}Name`;
      const nameColumn = `${idColumn}_name`;
      usedNames.add(idColumn);
      usedNames.add(nameColumn);
      columns.push({ field, column: idColumn, type: 'UUID', fk: fkConfig, fkNameField: nameField });
      columns.push({ field: nameField, column: nameColumn, type: 'TEXT', isFkNameFor: field });
      continue;
    }

    let type;
    if (fieldHasObject[field]) type = 'JSONB';
    else {
      const types = fieldTypes[field];
      if (types.size === 0) type = 'TEXT';
      else if (types.size === 1 && types.has('boolean')) type = 'BOOLEAN';
      else if (types.size === 1 && types.has('number')) type = 'NUMERIC';
      else type = 'TEXT';
    }
    let column = toSnakeCase(field);
    if (usedNames.has(column)) {
      let n = 2;
      while (usedNames.has(`${column}_${n}`)) n++;
      column = `${column}_${n}`;
    }
    usedNames.add(column);
    columns.push({ field, column, type });
  }

  return columns;
}

function formatValue(v, type) {
  if (v === null || v === undefined) return 'NULL';
  if (type === 'JSONB') return "'" + escapeText(JSON.stringify(v)) + "'::jsonb";
  if (type === 'BOOLEAN') return v ? 'TRUE' : 'FALSE';
  if (type === 'NUMERIC') return typeof v === 'number' && Number.isFinite(v) ? String(v) : 'NULL';
  if (type === 'UUID') return v ? `'${v}'` : 'NULL';
  return "'" + escapeText(String(v)) + "'";
}

const BATCH_SIZE = 500;

// Turns a raw Firebase export into { tableName: [{ rowKey, record }] },
// applying the same namespace-flattening and 5-way customers merge both
// buildImportPlan (full replace) and buildIncrementalImportPlan (additive)
// need identically - so a row parsed one way always lands on the same
// table/rowKey regardless of which import mode is used.
function parseFirebaseTables(data) {
  if (!data || typeof data !== 'object') {
    const err = new Error('Uploaded file is not a valid JSON object');
    err.status = 400;
    throw err;
  }

  const tables = {};
  function addTable(tableName, obj) {
    const rows = [];
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      rows.push({ rowKey: key, record: val === null || typeof val !== 'object' ? { value: val } : val });
    }
    tables[tableName] = rows;
  }

  // The 5 customers/* subnodes (bigtruck, smalltruck, gasstations, tickets,
  // transports) merge into one "customers" table tagged with Category,
  // instead of 5 separate tables - see CUSTOMER_CATEGORIES above.
  function addMergedCustomers(customersNode) {
    const rows = [];
    for (const subKey of Object.keys(customersNode)) {
      const subVal = customersNode[subKey];
      if (!subVal || typeof subVal !== 'object' || !CUSTOMER_CATEGORIES.has(subKey)) continue;
      for (const rowKey of Object.keys(subVal)) {
        const val = subVal[rowKey];
        const record = val === null || typeof val !== 'object' ? { value: val } : { ...val };
        for (const dropField of CUSTOMER_MERGE_DROP_FIELDS) delete record[dropField];
        record.Category = subKey;
        // Prefixed so rows from different categories (which reuse the same
        // small row-key/id ranges) don't collide once merged into one table.
        rows.push({ rowKey: `${subKey}_${rowKey}`, record });
      }
    }
    if (rows.length) tables.customers = rows;
  }

  for (const topKey of Object.keys(data)) {
    const topVal = data[topKey];
    if (!topVal || typeof topVal !== 'object') continue;
    const tableBase = toSnakeCase(topKey);
    if (topKey === 'customers') {
      addMergedCustomers(topVal);
    } else if (NAMESPACE_NODES.has(topKey)) {
      for (const subKey of Object.keys(topVal)) {
        const subVal = topVal[subKey];
        if (!subVal || typeof subVal !== 'object') continue;
        addTable(`${tableBase}_${toSnakeCase(subKey)}`, subVal);
      }
    } else {
      addTable(tableBase, topVal);
    }
  }

  if (!Object.keys(tables).length) {
    const err = new Error('No importable tables found in the uploaded JSON');
    err.status = 400;
    throw err;
  }

  return tables;
}

export function buildImportPlan(data) {
  const tables = parseFirebaseTables(data);
  const tableNames = Object.keys(tables).sort();

  // Every row gets its own fresh UUID up front, so (a) it can be used as this
  // row's own primary key value and (b) other rows can reference it as an FK
  // before we've even started building SQL for this table.
  const uuidByTableRowKey = {};
  // For resolving "id:name" FK text into the target's UUID. Flat {id: uuid}
  // for every table except "customers", where ids are only unique per
  // Category (a merged table of 5 originally-separate sources) - nested one
  // level deeper there: {category: {id: uuid}}.
  const uuidByTableId = {};
  for (const [table, rows] of Object.entries(tables)) {
    uuidByTableRowKey[table] = {};
    uuidByTableId[table] = {};
    for (const { rowKey, record } of rows) {
      const uuid = crypto.randomUUID();
      uuidByTableRowKey[table][rowKey] = uuid;
      if (typeof record.id !== 'number') continue;
      if (table === 'customers') {
        const byCategory = (uuidByTableId[table][record.Category] ??= {});
        byCategory[record.id] = uuid;
      } else {
        uuidByTableId[table][record.id] = uuid;
      }
    }
  }

  const manifest = {};
  const summary = [];
  const fkNullCounts = {}; // "table.field" -> count of refs that didn't resolve
  const fkConstraints = []; // { table, column, targetTable }
  const sqlParts = ["SET client_encoding = 'UTF8';", 'BEGIN;'];

  for (const tableName of tableNames) {
    const rows = tables[tableName];
    const columns = classifyColumns(tableName, rows);
    const qTable = quoteIdent(tableName);

    manifest[tableName] = {
      primaryKey: 'uuid',
      rowCount: rows.length,
      columns: columns.map((c) => ({ field: c.field, column: c.column, type: c.type })),
    };
    summary.push({ table: tableName, rows: rows.length });

    sqlParts.push(`DROP TABLE IF EXISTS ${qTable} CASCADE;`);
    const colDefs = [
      `  ${quoteIdent('uuid')} UUID PRIMARY KEY`,
      `  ${quoteIdent('row_key')} TEXT`,
    ];
    for (const col of columns) colDefs.push(`  ${quoteIdent(col.column)} ${col.type}`);
    sqlParts.push(`CREATE TABLE ${qTable} (\n${colDefs.join(',\n')}\n);`);

    for (const col of columns) {
      if (!col.fk) continue;
      fkConstraints.push({ table: tableName, column: col.column, targetTable: col.fk.target });
    }

    if (rows.length > 0) {
      const colNames = [quoteIdent('uuid'), quoteIdent('row_key'), ...columns.map((c) => quoteIdent(c.column))];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const valueLines = batch.map(({ rowKey, record }) => {
          const vals = [
            `'${uuidByTableRowKey[tableName][rowKey]}'`,
            `'${escapeText(rowKey)}'`,
          ];
          for (const col of columns) {
            if (col.fk) {
              const parsed = parseIdName(record[col.field]);
              let targetUuid;
              if (parsed && col.fk.discriminatorField) {
                const category = col.fk.discriminatorMap[record[col.fk.discriminatorField]];
                targetUuid = category ? uuidByTableId[col.fk.target]?.[category]?.[parsed.id] : undefined;
              } else if (parsed) {
                targetUuid = uuidByTableId[col.fk.target]?.[parsed.id];
              }
              if (parsed && !targetUuid) {
                const key = `${tableName}.${col.field}`;
                fkNullCounts[key] = (fkNullCounts[key] || 0) + 1;
              }
              vals.push(formatValue(targetUuid || null, 'UUID'));
            } else if (col.isFkNameFor) {
              // Companion text column for a preceding FK field.
              const parsed = parseIdName(record[col.isFkNameFor]);
              const name = parsed ? parsed.name : record[col.isFkNameFor] ?? null;
              vals.push(formatValue(name, 'TEXT'));
            } else {
              vals.push(formatValue(record[col.field], col.type));
            }
          }
          return '  (' + vals.join(', ') + ')';
        });
        sqlParts.push(`INSERT INTO ${qTable} (${colNames.join(', ')}) VALUES\n${valueLines.join(',\n')};`);
      }
    }
  }

  // Constraints are added after every table exists and is populated, so
  // creation order and cross-table references never matter. Unlike the
  // human "id" (which can duplicate, e.g. companypayment has 3 dupes in the
  // source data), "uuid" is always unique by construction, so every FK here
  // can have a real constraint - no exceptions needed.
  for (const fk of fkConstraints) {
    const constraintName = `${fk.table}_${fk.column}_fkey`;
    sqlParts.push(
      `ALTER TABLE ${quoteIdent(fk.table)} ADD CONSTRAINT ${quoteIdent(constraintName)} ` +
        `FOREIGN KEY (${quoteIdent(fk.column)}) REFERENCES ${quoteIdent(fk.targetTable)} ("uuid");`
    );
  }

  sqlParts.push('COMMIT;');

  const fkSummary = Object.entries(fkNullCounts).map(([key, count]) => ({ field: key, unresolvedRefs: count }));

  return { sql: sqlParts.join('\n'), manifest, summary, fkSummary };
}

function quoteIdentPlain(name) {
  return name.replace(/"/g, '""');
}

// Adds ONLY rows that don't already exist yet, leaving everything currently
// in Postgres untouched - for pulling in records a newer/more complete
// Firebase export has that the original one-time migration missed, without
// re-running the full destructive replace buildImportPlan does (which would
// drop every table and lose anything created directly through the live app
// since the cutover - new customers, transfers, tickets, none of which were
// ever written back to Firebase).
//
// A row already exists if its Firebase key (stored as "row_key", see the
// header comment above) is already present in that table. New rows that
// reference another row via an "id:name" FK field get resolved against
// whichever has the matching numeric id - an existing DB row first, or
// another new row from this same batch (in case the export adds, say, a new
// customer and a new ticket for that customer in one go).
//
// If the export introduces a field that has no column yet (Firebase added it
// after the last import), a column is added for it via ALTER TABLE and the
// on-disk manifest is updated to match - existing rows just get NULL there.
// If the export contains an entire table this database has never seen
// before, it's created fresh (same as buildImportPlan would for it) with
// every row treated as new.
export async function buildIncrementalImportPlan(data, pool) {
  const tables = parseFirebaseTables(data);
  const tableNames = Object.keys(tables).sort();

  // Shallow copy so this function stays a pure "compute the plan" - the
  // caller decides whether to persist the updated manifest (setManifest),
  // and only after the SQL it returns has actually been committed.
  const manifest = { ...getManifest() };
  const sqlParts = ["SET client_encoding = 'UTF8';", 'BEGIN;'];
  const summary = [];
  const fkNullCounts = {};
  const manifestUpdates = {}; // tableName -> full updated column list

  const { rows: existingTableRows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`
  );
  const existingTableNames = new Set(existingTableRows.map((r) => r.table_name));

  // Lazily loaded/cached id->uuid maps for existing DB rows, keyed by target
  // table name ("customers" maps to {category: {id: uuid}}, everything else
  // to {id: uuid}) - loaded once per target table no matter how many source
  // tables FK into it.
  const existingIdMapCache = {};
  async function loadExistingIdMap(targetTable) {
    if (existingIdMapCache[targetTable]) return existingIdMapCache[targetTable];
    if (!existingTableNames.has(targetTable)) {
      existingIdMapCache[targetTable] = {};
      return existingIdMapCache[targetTable];
    }
    if (targetTable === 'customers') {
      const { rows } = await pool.query(`SELECT "category", "id", "uuid" FROM "customers" WHERE "id" IS NOT NULL`);
      const map = {};
      for (const r of rows) {
        (map[r.category] ??= {})[Number(r.id)] = r.uuid;
      }
      existingIdMapCache[targetTable] = map;
    } else {
      const { rows } = await pool.query(`SELECT "id", "uuid" FROM "${quoteIdentPlain(targetTable)}" WHERE "id" IS NOT NULL`);
      const map = {};
      for (const r of rows) map[Number(r.id)] = r.uuid;
      existingIdMapCache[targetTable] = map;
    }
    return existingIdMapCache[targetTable];
  }

  // Pass 1: for every table, work out which rows are genuinely new and hand
  // each one a fresh uuid - done for every table up front (independent of
  // FK resolution/SQL generation below) so a new row in one table can be
  // referenced by a new row in another table processed either before or
  // after it in this same run.
  const newRowsByTable = {};
  const freshUuidByRowKey = {};
  const freshIdMapByTable = {}; // same shape as loadExistingIdMap's return

  for (const tableName of tableNames) {
    const rows = tables[tableName];
    const tableExists = existingTableNames.has(tableName);

    let newRows = rows;
    if (tableExists) {
      const { rows: keyRows } = await pool.query(`SELECT "row_key" FROM "${quoteIdentPlain(tableName)}"`);
      const existingRowKeys = new Set(keyRows.map((r) => r.row_key));
      newRows = rows.filter((r) => !existingRowKeys.has(r.rowKey));
    }

    newRowsByTable[tableName] = newRows;
    summary.push({ table: tableName, newRows: newRows.length, skippedExisting: rows.length - newRows.length });

    const idMap = {};
    for (const { rowKey, record } of newRows) {
      const uuid = crypto.randomUUID();
      freshUuidByRowKey[`${tableName} ${rowKey}`] = uuid;
      if (typeof record.id !== 'number') continue;
      if (tableName === 'customers') {
        (idMap[record.Category] ??= {})[record.id] = uuid;
      } else {
        idMap[record.id] = uuid;
      }
    }
    freshIdMapByTable[tableName] = idMap;
  }

  // Two known tables FK into each other (employee_drivers.Registration ->
  // truck_registration, truck_registration.Driver -> employee_drivers) - a
  // genuine cycle, so no processing order could satisfy both tables' FK
  // constraints at INSERT time if each gets a new row referencing the
  // other's new row in the same batch. Every new row is inserted with its
  // FK columns left NULL; every FK value is filled in with a separate
  // UPDATE pass only after every table's new rows already exist, so a
  // reference resolves regardless of which table "goes first". New tables'
  // FK constraints are added last, after that backfill - same as
  // buildImportPlan already does for a full import.
  const pendingFkBackfill = []; // { qTable, column, rowUuid, parsed, fk, record }
  const newTableFkConstraints = []; // { qTable, column, target }

  async function appendInsertsAndConstraints(tableName, qTable, columns, newRows, isNewTable) {
    if (newRows.length === 0) return;

    if (isNewTable) {
      for (const col of columns) {
        if (!col.fk) continue;
        newTableFkConstraints.push({ qTable, column: col.column, target: col.fk.target });
      }
    }

    const colNames = [quoteIdent('uuid'), quoteIdent('row_key'), ...columns.map((c) => quoteIdent(c.column))];
    for (let i = 0; i < newRows.length; i += BATCH_SIZE) {
      const batch = newRows.slice(i, i + BATCH_SIZE);
      const valueLines = [];
      for (const { rowKey, record } of batch) {
        const rowUuid = freshUuidByRowKey[`${tableName} ${rowKey}`];
        const vals = [`'${rowUuid}'`, `'${escapeText(rowKey)}'`];
        for (const col of columns) {
          if (col.fk) {
            const parsed = parseIdName(record[col.field]);
            if (parsed) {
              pendingFkBackfill.push({ tableName, qTable, column: col.column, rowUuid, parsed, fk: col.fk, record });
            }
            vals.push('NULL'); // resolved and filled in by the backfill pass below
          } else if (col.isFkNameFor) {
            const parsed = parseIdName(record[col.isFkNameFor]);
            const name = parsed ? parsed.name : (record[col.isFkNameFor] ?? null);
            vals.push(formatValue(name, 'TEXT'));
          } else {
            vals.push(formatValue(record[col.field], col.type));
          }
        }
        valueLines.push('  (' + vals.join(', ') + ')');
      }
      sqlParts.push(`INSERT INTO ${qTable} (${colNames.join(', ')}) VALUES\n${valueLines.join(',\n')};`);
    }
  }

  // Pass 2: build SQL only for tables that actually have new rows (or don't
  // exist yet at all).
  for (const tableName of tableNames) {
    const newRows = newRowsByTable[tableName];
    const qTable = quoteIdent(tableName);
    const tableExists = existingTableNames.has(tableName);

    if (!tableExists) {
      // Never-seen-before table - create it fresh, every row is new.
      const columns = classifyColumns(tableName, newRows);
      manifest[tableName] = {
        primaryKey: 'uuid',
        rowCount: newRows.length,
        columns: columns.map((c) => ({ field: c.field, column: c.column, type: c.type })),
      };
      manifestUpdates[tableName] = manifest[tableName].columns;

      const colDefs = [`  ${quoteIdent('uuid')} UUID PRIMARY KEY`, `  ${quoteIdent('row_key')} TEXT`];
      for (const col of columns) colDefs.push(`  ${quoteIdent(col.column)} ${col.type}`);
      sqlParts.push(`CREATE TABLE ${qTable} (\n${colDefs.join(',\n')}\n);`);

      await appendInsertsAndConstraints(tableName, qTable, columns, newRows, true);
      continue;
    }

    if (newRows.length === 0) continue;

    // Existing table - figure out which of the fields present in the new
    // rows already have a column, and which need one added. Checked against
    // the LIVE table (information_schema), not just schema-manifest.json -
    // the manifest is expected to stay in sync, but a table created or
    // altered by some other path (a manual SQL migration that forgot to
    // update it, say) would otherwise make every column look "new" and
    // crash on the first ALTER TABLE ADD COLUMN for one that already exists.
    const columns = classifyColumns(tableName, newRows);
    const existingDef = manifest[tableName];
    const { rows: liveColumnRows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
      [tableName]
    );
    const existingColumnNames = new Set(liveColumnRows.map((r) => r.column_name));
    const columnsToAdd = columns.filter((c) => !existingColumnNames.has(c.column));

    for (const col of columnsToAdd) {
      sqlParts.push(`ALTER TABLE ${qTable} ADD COLUMN ${quoteIdent(col.column)} ${col.type};`);
    }
    if (columnsToAdd.length) {
      manifest[tableName] = {
        ...existingDef,
        columns: [
          ...(existingDef?.columns || []),
          ...columnsToAdd.map((c) => ({ field: c.field, column: c.column, type: c.type })),
        ],
      };
      manifestUpdates[tableName] = manifest[tableName].columns;
    }

    await appendInsertsAndConstraints(tableName, qTable, columns, newRows, false);
  }

  // Every table's new rows now exist (still with NULL FK columns), so every
  // reference can resolve regardless of which table it points at or which
  // order things were inserted in - including the employee_drivers <->
  // truck_registration cycle. One UPDATE per (table, FK column) pair,
  // matching each new row's uuid to its resolved target uuid via a VALUES
  // list, rather than one UPDATE per row.
  const backfillByTableColumn = new Map(); // "qTable:column" -> [{ rowUuid, targetUuid }]
  for (const { tableName, qTable, column, rowUuid, parsed, fk, record } of pendingFkBackfill) {
    const targetFresh = freshIdMapByTable[fk.target] || {};
    const targetExisting = await loadExistingIdMap(fk.target);
    let targetUuid;
    if (fk.discriminatorField) {
      const category = fk.discriminatorMap[record[fk.discriminatorField]];
      targetUuid = (category && targetFresh[category]?.[parsed.id]) || (category && targetExisting[category]?.[parsed.id]);
    } else {
      targetUuid = targetFresh[parsed.id] ?? targetExisting[parsed.id];
    }
    if (!targetUuid) {
      const key = `${tableName}.${column}`;
      fkNullCounts[key] = (fkNullCounts[key] || 0) + 1;
    }
    const mapKey = `${qTable}:${column}`;
    if (!backfillByTableColumn.has(mapKey)) backfillByTableColumn.set(mapKey, []);
    backfillByTableColumn.get(mapKey).push({ rowUuid, targetUuid: targetUuid || null });
  }

  for (const [mapKey, entries] of backfillByTableColumn) {
    const [qTable, column] = mapKey.split(':');
    const valuesList = entries
      .map((e) => `('${e.rowUuid}', ${e.targetUuid ? `'${e.targetUuid}'` : 'NULL'})`)
      .join(',\n  ');
    sqlParts.push(
      `UPDATE ${qTable} AS t SET ${quoteIdent(column)} = v.target_uuid::uuid ` +
        `FROM (VALUES\n  ${valuesList}\n) AS v(row_uuid, target_uuid) ` +
        `WHERE t."uuid" = v.row_uuid::uuid;`
    );
  }

  for (const { qTable, column, target } of newTableFkConstraints) {
    const constraintName = `${qTable.replace(/"/g, '')}_${column}_fkey`;
    sqlParts.push(
      `ALTER TABLE ${qTable} ADD CONSTRAINT ${quoteIdent(constraintName)} ` +
        `FOREIGN KEY (${quoteIdent(column)}) REFERENCES ${quoteIdent(target)} ("uuid");`
    );
  }

  sqlParts.push('COMMIT;');

  const fkSummary = Object.entries(fkNullCounts).map(([key, count]) => ({ field: key, unresolvedRefs: count }));
  const totalNewRows = summary.reduce((sum, t) => sum + t.newRows, 0);

  return {
    sql: totalNewRows > 0 ? sqlParts.join('\n') : null,
    manifest,
    summary,
    fkSummary,
    manifestUpdates,
    totalNewRows,
  };
}
