// Converts a Firebase Realtime Database export (parsed JSON) into SQL that
// drops and recreates all derived tables, then returns that SQL plus a fresh
// schema manifest (column name mapping) and a row-count summary.
//
// This is the same logic used to build the original sql/scd-panda-dump.sql,
// plus: a curated set of "id:name" fields (a workaround Firebase forced since
// it has no real foreign keys) get split into a real numeric id column + a
// companion "{Field}Name" text column, with an actual FK constraint added
// where the target table's id is verifiably unique. The mapping below was
// derived by cross-checking every "id:name"-shaped field in the real export
// against every candidate table's identifying text field - fields that are
// genuinely polymorphic (can point at different tables depending on the row,
// e.g. TicketName/Customer/Order1-9/Ticket1-27) or that had no reliable
// single target were deliberately left alone.

const NAMESPACE_NODES = new Set(['customers', 'depot', 'employee', 'report', 'truck']);

// tableName -> { fieldName -> { target: tableName, addConstraint: boolean } }
const FK_FIELDS = {
  customers_bigtruck: { Company: { target: 'company' } },
  customers_smalltruck: { Company: { target: 'company' } },
  employee_drivers: { Position: { target: 'positions' }, Registration: { target: 'truck_registration' } },
  employee_officers: { Position: { target: 'positions' } },
  inspection: { Employee: { target: 'employee_drivers' }, employee: { target: 'employee_drivers' } },
  order: { Driver: { target: 'employee_drivers' }, Registration: { target: 'truck_registration' } },
  quotation: { Company: { target: 'company' }, Employee: { target: 'employee_officers' } },
  report_financial: {
    Driver: { target: 'employee_drivers' },
    RegHead: { target: 'truck_registration' },
    RegTail: { target: 'truck_registration_tail' },
  },
  report_invoice: {
    // Misleadingly named in the source data - verified against real content.
    Bank: { target: 'expenseitems' },
    // companypayment.id has duplicates in the source data, so this is split
    // for clarity but not backed by a real UNIQUE/FK constraint.
    Company: { target: 'companypayment', addConstraint: false },
  },
  tickets: { Driver: { target: 'employee_drivers' }, Registration: { target: 'truck_registration' } },
  transfermoney: { BankName: { target: 'banks' } },
  trip: { Driver: { target: 'employee_drivers' }, Registration: { target: 'truck_registration' } },
  truck_registration: { Driver: { target: 'employee_drivers' }, RegTail: { target: 'truck_registration_tail' } },
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
      const { target, addConstraint = true } = fkFields[field];
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
      columns.push({ field, column: idColumn, type: 'NUMERIC', fk: { target, addConstraint }, fkNameField: nameField });
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

  for (const topKey of Object.keys(data)) {
    const topVal = data[topKey];
    if (!topVal || typeof topVal !== 'object') continue;
    const tableBase = toSnakeCase(topKey);
    if (NAMESPACE_NODES.has(topKey)) {
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

  // Pre-compute each table's numeric "id" set so FK columns can be null'd
  // out instead of pointing at an id that doesn't actually exist.
  const idSets = {};
  for (const [table, rows] of Object.entries(tables)) {
    const ids = new Set();
    for (const { record } of rows) if (typeof record.id === 'number') ids.add(record.id);
    idSets[table] = ids;
  }

  const manifest = {};
  const summary = [];
  const fkNullCounts = {}; // "table.field" -> count of refs that didn't resolve
  const uniqueConstraintTables = new Set();
  const fkConstraints = []; // { table, column, targetTable }
  const sqlParts = ["SET client_encoding = 'UTF8';", 'BEGIN;'];

  for (const tableName of tableNames) {
    const rows = tables[tableName];
    const columns = classifyColumns(tableName, rows);
    const qTable = quoteIdent(tableName);

    manifest[tableName] = {
      primaryKey: 'row_key',
      rowCount: rows.length,
      columns: columns.map((c) => ({ field: c.field, column: c.column, type: c.type })),
    };
    summary.push({ table: tableName, rows: rows.length });

    sqlParts.push(`DROP TABLE IF EXISTS ${qTable} CASCADE;`);
    const colDefs = [`  ${quoteIdent('row_key')} TEXT PRIMARY KEY`];
    for (const col of columns) colDefs.push(`  ${quoteIdent(col.column)} ${col.type}`);
    sqlParts.push(`CREATE TABLE ${qTable} (\n${colDefs.join(',\n')}\n);`);

    for (const col of columns) {
      if (!col.fk) continue;
      if (col.fk.addConstraint) uniqueConstraintTables.add(col.fk.target);
      fkConstraints.push({ table: tableName, column: col.column, targetTable: col.fk.target, addConstraint: col.fk.addConstraint });
    }

    if (rows.length > 0) {
      const colNames = [quoteIdent('row_key'), ...columns.map((c) => quoteIdent(c.column))];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const valueLines = batch.map(({ rowKey, record }) => {
          const vals = [`'${escapeText(rowKey)}'`];
          for (const col of columns) {
            if (col.fk) {
              const parsed = parseIdName(record[col.field]);
              let idValue = parsed ? parsed.id : null;
              if (idValue !== null && !idSets[col.fk.target]?.has(idValue)) {
                idValue = null;
                const key = `${tableName}.${col.field}`;
                fkNullCounts[key] = (fkNullCounts[key] || 0) + 1;
              }
              vals.push(formatValue(idValue, 'NUMERIC'));
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
  // creation order and cross-table references never matter.
  for (const target of uniqueConstraintTables) {
    sqlParts.push(
      `ALTER TABLE ${quoteIdent(target)} ADD CONSTRAINT ${quoteIdent(target + '_id_unique')} UNIQUE ("id");`
    );
  }
  for (const fk of fkConstraints) {
    if (!fk.addConstraint) continue;
    const constraintName = `${fk.table}_${fk.column}_fkey`;
    sqlParts.push(
      `ALTER TABLE ${quoteIdent(fk.table)} ADD CONSTRAINT ${quoteIdent(constraintName)} ` +
        `FOREIGN KEY (${quoteIdent(fk.column)}) REFERENCES ${quoteIdent(fk.targetTable)} ("id");`
    );
  }

  sqlParts.push('COMMIT;');

  const fkSummary = Object.entries(fkNullCounts).map(([key, count]) => ({ field: key, unresolvedRefs: count }));

  return { sql: sqlParts.join('\n'), manifest, summary, fkSummary };
}
