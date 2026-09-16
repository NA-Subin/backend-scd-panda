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
  employee_drivers: {
    Position: { target: 'positions' },
    // Firebase used this one field for EITHER a truck_registration id
    // (TruckType "รถใหญ่") OR a truck_small id (TruckType "รถเล็ก") - never
    // validated, just convention. Postgres can't FK one column at two
    // tables, so this splits into two real column pairs by TruckType
    // instead - see split_employee_drivers_registration.sql.
    Registration: {
      splitByTruckType: {
        'รถใหญ่': { target: 'truck_registration', field: 'Registration', column: 'registration', nameField: 'RegistrationName', nameColumn: 'registration_name' },
        'รถเล็ก': { target: 'truck_small', field: 'RegistrationSmall', column: 'registration_small', nameField: 'RegistrationSmallName', nameColumn: 'registration_small_name' },
      },
    },
  },
  employee_officers: { Position: { target: 'positions' }, GasStation: { target: 'depot_gas_stations' } },
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
  quotation: {
    Company: { target: 'company' },
    Employee: { target: 'employee_officers' },
    // Customer ids are only unique within one of the 5 merged customers
    // categories (see CUSTOMER_CATEGORIES) - quotation.Truck ("รถใหญ่" /
    // "รถเล็ก", confirmed the only 2 values that ever appear) says which.
    Customer: {
      target: 'customers',
      discriminatorField: 'Truck',
      discriminatorMap: {
        'รถใหญ่': 'bigtruck',
        'รถเล็ก': 'smalltruck',
      },
    },
  },
  report_financial: {
    Driver: { target: 'employee_drivers' },
    RegHead: { target: 'truck_registration' },
    RegTail: { target: 'truck_registration_tail' },
    // Which income/deduction category this entry is - confirmed against
    // real data (deductibleincome.id=1 is literally "เงินเดือน", matching
    // report_financial rows storing "1:เงินเดือน" here).
    Name: { target: 'deductibleincome' },
  },
  report_invoice: {
    // Misleadingly named in the source data - verified against real content.
    Bank: { target: 'expenseitems' },
    Company: { target: 'companypayment' },
    Registration: { target: 'truck_registration' },
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
  truck_small: { Company: { target: 'company' }, Driver: { target: 'employee_drivers' } },
  truck_transport: { Company: { target: 'company' } },
  depot_gas_stations: { Stock: { target: 'depot_stock' } },
};

// Thai display names for products.Product_name - see PRODUCT_TH_NAME below.
const PRODUCT_TH_NAME = {
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

// tableName -> [{ field, column, type, compute(record) }] - columns that
// carry real app data but have no source field in the Firebase export at
// all (unlike FK_FIELDS above, which only reshapes a field that IS present).
// Without this, a full re-import (which drops and recreates every table
// purely from the fields present in that import) would silently wipe these
// back out, since classifyColumns() only ever sees Firebase's own fields.
const SYNTHETIC_COLUMNS = {
  products: [
    {
      field: 'NameTH',
      column: 'name_th',
      type: 'TEXT',
      compute: (record) => PRODUCT_TH_NAME[record.Product_name] || null,
    },
    {
      field: 'IsActive',
      column: 'is_active',
      type: 'BOOLEAN',
      // New product rows are assumed available for use by default - nothing
      // in the source data says otherwise, and someone can flip this off
      // through the app once the product picker actually reads it.
      compute: () => true,
    },
  ],
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
    if (fkFields[field]?.splitByTruckType) {
      // One source field fans out into a separate real column pair per
      // TruckType - only the pair matching a given row's TruckType ever
      // gets filled in (see the splitFk/splitFkNameFor handling below);
      // the other pair stays NULL for that row.
      for (const [truckType, dest] of Object.entries(fkFields[field].splitByTruckType)) {
        usedNames.add(dest.column);
        usedNames.add(dest.nameColumn);
        columns.push({
          field: dest.field,
          column: dest.column,
          type: 'UUID',
          splitFk: { sourceField: field, truckType, target: dest.target },
        });
        columns.push({
          field: dest.nameField,
          column: dest.nameColumn,
          type: 'TEXT',
          splitFkNameFor: { sourceField: field, truckType },
        });
      }
      continue;
    }

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

  for (const synth of SYNTHETIC_COLUMNS[tableName] || []) {
    let column = synth.column;
    if (usedNames.has(column)) {
      let n = 2;
      while (usedNames.has(`${column}_${n}`)) n++;
      column = `${column}_${n}`;
    }
    usedNames.add(column);
    columns.push({ field: synth.field, column, type: synth.type, synthetic: synth });
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
  const warnings = [];
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
      if (!subVal || typeof subVal !== 'object') continue;
      if (!CUSTOMER_CATEGORIES.has(subKey)) {
        // A category this importer doesn't know about yet (new in the
        // source, or a typo) - skip it rather than guess, but say so loudly
        // instead of silently dropping every row under it.
        warnings.push(
          `พบหมวดหมู่ลูกค้า "customers/${subKey}" ที่ไม่รู้จัก (${Object.keys(subVal).length} แถว) ` +
            `ข้อมูลส่วนนี้ไม่ถูกนำเข้า ต้องเพิ่มหมวดหมู่นี้ในโค้ด (CUSTOMER_CATEGORIES) ก่อน`
        );
        continue;
      }
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

  return { tables, warnings };
}

export function buildImportPlan(data) {
  const { tables, warnings } = parseFirebaseTables(data);
  const tableNames = Object.keys(tables).sort();

  // A table this database already knows about but that isn't in THIS JSON
  // at all is left completely untouched below (not dropped, not recreated) -
  // flag that explicitly rather than let it pass silently, since "ทับข้อมูล
  // เดิมทั้งหมด" reads as "replace everything" and a JSON missing a table
  // (an incomplete export, a renamed node) is easy to miss otherwise.
  const missingTables = Object.keys(getManifest()).filter((t) => !tableNames.includes(t));
  if (missingTables.length) {
    warnings.push(
      `ไฟล์นี้ไม่มีตาราง: ${missingTables.join(', ')} - ตารางเหล่านี้จะไม่ถูกแตะต้อง (ข้อมูลเดิมยังอยู่ครบ) ` +
        `หากคาดว่าไฟล์นี้ควรมีตารางเหล่านี้ด้วย ควรตรวจสอบไฟล์ต้นฉบับก่อน`
    );
  }

  // Every row gets its own fresh UUID up front, so (a) it can be used as this
  // row's own primary key value and (b) other rows can reference it as an FK
  // before we've even started building SQL for this table.
  const uuidByTableRowKey = {};
  // For resolving "id:name" FK text into the target's UUID. Flat {id: uuid}
  // for every table except "customers", where ids are only unique per
  // Category (a merged table of 5 originally-separate sources) - nested one
  // level deeper there: {category: {id: uuid}}.
  const uuidByTableId = {};
  // A duplicate "id" within one table (source data has had cases of this,
  // e.g. companypayment) means the LAST row with that id silently wins every
  // "id:name" FK resolution below - earlier rows sharing the id become
  // unreachable as an FK target. Can't fix this without a business-rule
  // decision (which row was actually meant), so at minimum warn loudly
  // instead of resolving to a possibly-wrong row with no indication anything
  // was ambiguous.
  const duplicateIdTables = new Set();
  for (const [table, rows] of Object.entries(tables)) {
    uuidByTableRowKey[table] = {};
    uuidByTableId[table] = {};
    for (const { rowKey, record } of rows) {
      const uuid = crypto.randomUUID();
      uuidByTableRowKey[table][rowKey] = uuid;
      if (typeof record.id !== 'number') continue;
      if (table === 'customers') {
        const byCategory = (uuidByTableId[table][record.Category] ??= {});
        if (record.id in byCategory) duplicateIdTables.add(`${table} (${record.Category})`);
        byCategory[record.id] = uuid;
      } else {
        if (record.id in uuidByTableId[table]) duplicateIdTables.add(table);
        uuidByTableId[table][record.id] = uuid;
      }
    }
  }
  for (const label of duplicateIdTables) {
    warnings.push(
      `ตาราง "${label}" มีค่า id ซ้ำกันในข้อมูลต้นฉบับ - แถวที่ตารางอื่นอ้างอิงมาทาง id นี้อาจเชื่อมผิดแถว ` +
        `(ระบบเชื่อมกับแถวล่าสุดที่เจอ id นี้เสมอ) ควรตรวจสอบ/แก้ไข id ซ้ำในระบบต้นทางก่อน`
    );
  }

  // Start from the existing manifest (same as buildIncrementalImportPlan),
  // not {} - a table absent from THIS JSON is never dropped or touched below
  // (the loop only covers tableNames, i.e. this JSON's own top-level keys),
  // so its manifest entry must survive too. Starting from {} here used to
  // wholesale-replace the manifest with only what this import mentioned,
  // which left every other table's physical data untouched but invisible to
  // the app - assertValidTable() throws "Unknown table" for it, and since
  // /api/basic-data fetches every BASIC_DATA_MAP table in one Promise.all,
  // one missing table there broke the entire basic-data response.
  const manifest = { ...getManifest() };
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
      if (col.fk) fkConstraints.push({ table: tableName, column: col.column, targetTable: col.fk.target });
      else if (col.splitFk) fkConstraints.push({ table: tableName, column: col.column, targetTable: col.splitFk.target });
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
            } else if (col.splitFk) {
              // Only fill this pair in for the TruckType it belongs to -
              // the row's value is meaningless for every other pair.
              const matches = record.TruckType === col.splitFk.truckType;
              const parsed = matches ? parseIdName(record[col.splitFk.sourceField]) : null;
              const targetUuid = parsed ? uuidByTableId[col.splitFk.target]?.[parsed.id] : undefined;
              if (matches && parsed && !targetUuid) {
                const key = `${tableName}.${col.field}`;
                fkNullCounts[key] = (fkNullCounts[key] || 0) + 1;
              }
              vals.push(formatValue(targetUuid || null, 'UUID'));
            } else if (col.splitFkNameFor) {
              const matches = record.TruckType === col.splitFkNameFor.truckType;
              const parsed = matches ? parseIdName(record[col.splitFkNameFor.sourceField]) : null;
              const name = matches ? (parsed ? parsed.name : record[col.splitFkNameFor.sourceField] ?? null) : null;
              vals.push(formatValue(name, 'TEXT'));
            } else if (col.synthetic) {
              vals.push(formatValue(col.synthetic.compute(record), col.type));
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

  return { sql: sqlParts.join('\n'), manifest, summary, fkSummary, warnings };
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
  const { tables, warnings } = parseFirebaseTables(data);
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
    let hasDuplicateId = false;
    for (const { rowKey, record } of newRows) {
      const uuid = crypto.randomUUID();
      freshUuidByRowKey[`${tableName} ${rowKey}`] = uuid;
      if (typeof record.id !== 'number') continue;
      if (tableName === 'customers') {
        const byCategory = (idMap[record.Category] ??= {});
        if (record.id in byCategory) hasDuplicateId = true;
        byCategory[record.id] = uuid;
      } else {
        if (record.id in idMap) hasDuplicateId = true;
        idMap[record.id] = uuid;
      }
    }
    freshIdMapByTable[tableName] = idMap;
    if (hasDuplicateId) {
      warnings.push(
        `ตาราง "${tableName}" มีค่า id ซ้ำกันในแถวใหม่ที่กำลังนำเข้า - แถวที่ตารางอื่นอ้างอิงมาทาง id นี้อาจ` +
          `เชื่อมผิดแถว (ระบบเชื่อมกับแถวล่าสุดที่เจอ id นี้เสมอ) ควรตรวจสอบ/แก้ไข id ซ้ำในระบบต้นทางก่อน`
      );
    }
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
        if (col.fk) newTableFkConstraints.push({ qTable, column: col.column, target: col.fk.target });
        else if (col.splitFk) newTableFkConstraints.push({ qTable, column: col.column, target: col.splitFk.target });
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
          } else if (col.splitFk) {
            const matches = record.TruckType === col.splitFk.truckType;
            const parsed = matches ? parseIdName(record[col.splitFk.sourceField]) : null;
            if (parsed) {
              pendingFkBackfill.push({
                tableName,
                qTable,
                column: col.column,
                rowUuid,
                parsed,
                fk: { target: col.splitFk.target },
                record,
              });
            }
            vals.push('NULL'); // resolved and filled in by the backfill pass below
          } else if (col.splitFkNameFor) {
            const matches = record.TruckType === col.splitFkNameFor.truckType;
            const parsed = matches ? parseIdName(record[col.splitFkNameFor.sourceField]) : null;
            const name = matches ? (parsed ? parsed.name : record[col.splitFkNameFor.sourceField] ?? null) : null;
            vals.push(formatValue(name, 'TEXT'));
          } else if (col.synthetic) {
            vals.push(formatValue(col.synthetic.compute(record), col.type));
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
    warnings,
  };
}
