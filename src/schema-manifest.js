const manifest = require('./schema-manifest.json');

const TABLE_NAMES = Object.keys(manifest);

function assertValidTable(table) {
  if (!TABLE_NAMES.includes(table)) {
    const err = new Error(`Unknown table "${table}"`);
    err.status = 404;
    throw err;
  }
  return manifest[table];
}

// Builds: SELECT "row_key", "col1" AS "OriginalField1", "col2" AS "OriginalField2", ...
function selectColumnsSql(table) {
  const def = assertValidTable(table);
  const cols = def.columns.map((c) => `"${c.column}" AS "${c.field}"`);
  return ['"row_key"', ...cols].join(', ');
}

function assertValidColumns(table, fields) {
  const def = assertValidTable(table);
  const validFields = new Set(def.columns.map((c) => c.field));
  for (const field of fields) {
    if (!validFields.has(field)) {
      const err = new Error(`Unknown column "${field}" on table "${table}"`);
      err.status = 400;
      throw err;
    }
  }
}

function columnNameForField(table, field) {
  const def = assertValidTable(table);
  const col = def.columns.find((c) => c.field === field);
  return col ? col.column : null;
}

// Reference/"basic data" tables consumed by the frontend's BasicDataProvider.
// Keys match BasicDataProvider's state shape exactly.
const BASIC_DATA_MAP = {
  company: 'company',
  positions: 'positions',
  officers: 'employee_officers',
  drivers: 'employee_drivers',
  creditors: 'employee_creditors',
  reghead: 'truck_registration',
  regtail: 'truck_registration_tail',
  small: 'truck_small',
  transport: 'truck_transport',
  depots: 'depot_oils',
  gasstation: 'depot_gas_stations',
  customertransports: 'customers_transports',
  customergasstations: 'customers_gasstations',
  customerbigtruck: 'customers_bigtruck',
  customersmalltruck: 'customers_smalltruck',
  customertickets: 'customers_tickets',
  deductibleincome: 'deductibleincome',
  companypayment: 'companypayment',
  expenseitems: 'expenseitems',
  quotation: 'quotation',
  inspection: 'inspection',
};

module.exports = {
  manifest,
  TABLE_NAMES,
  BASIC_DATA_MAP,
  assertValidTable,
  assertValidColumns,
  selectColumnsSql,
  columnNameForField,
};
