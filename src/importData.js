// Converts a Firebase Realtime Database export (parsed JSON) into SQL that
// drops and recreates all derived tables, then returns that SQL plus a fresh
// schema manifest (column name mapping) and a row-count summary.
//
// This is the same logic used to build the original sql/scd-panda-dump.sql,
// adapted to run in-process against an uploaded JSON object instead of a file.

const NAMESPACE_NODES = new Set(['customers', 'depot', 'employee', 'report', 'truck']);

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

function classifyColumns(rows) {
  const fieldTypes = {};
  const fieldHasObject = {};
  const fieldOrder = [];

  for (const { record } of rows) {
    for (const field of Object.keys(record)) {
      if (!(field in fieldTypes)) {
        fieldTypes[field] = new Set();
        fieldHasObject[field] = false;
        fieldOrder.push(field);
      }
      const v = record[field];
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') {
        fieldHasObject[field] = true;
      } else {
        fieldTypes[field].add(typeof v);
      }
    }
  }

  const usedNames = new Set();
  return fieldOrder.map((field) => {
    let type;
    if (fieldHasObject[field]) {
      type = 'JSONB';
    } else {
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
    return { field, column, type };
  });
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

  const manifest = {};
  const summary = [];
  const sqlParts = ["SET client_encoding = 'UTF8';", 'BEGIN;'];

  for (const tableName of tableNames) {
    const rows = tables[tableName];
    const columns = classifyColumns(rows);
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

    if (rows.length > 0) {
      const colNames = [quoteIdent('row_key'), ...columns.map((c) => quoteIdent(c.column))];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const valueLines = batch.map(({ rowKey, record }) => {
          const vals = [`'${escapeText(rowKey)}'`];
          for (const col of columns) vals.push(formatValue(record[col.field], col.type));
          return '  (' + vals.join(', ') + ')';
        });
        sqlParts.push(`INSERT INTO ${qTable} (${colNames.join(', ')}) VALUES\n${valueLines.join(',\n')};`);
      }
    }
  }

  sqlParts.push('COMMIT;');

  return { sql: sqlParts.join('\n'), manifest, summary };
}
