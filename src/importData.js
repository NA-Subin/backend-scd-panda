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

export function buildImportPlan(data) {
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

  const tableNames = Object.keys(tables).sort();
  if (!tableNames.length) {
    const err = new Error('No importable tables found in the uploaded JSON');
    err.status = 400;
    throw err;
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
