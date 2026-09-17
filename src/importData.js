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
    // A 6th, genuinely different case from the 5 real customer categories
    // above: a "blank ticket" has no customer at all by design (confirmed
    // against real data - every one of these carries TicketName "1:ตั๋วเปล่า",
    // never a real customer name). Mapped to null (not omitted) so
    // resolveDiscriminatorCategory below can tell "known to have no target"
    // apart from "unrecognized value" - only the latter should still warn.
    'ตั๋วเปล่า': null,
  },
};

// See the "ตั๋วเปล่า" comment above - a discriminator value can be explicitly
// mapped to null (known to never have a target row) as well as absent from
// the map entirely (unrecognized - still worth warning about, could be a
// genuinely new category). Only the latter counts as unresolved.
function resolveDiscriminatorCategory(fk, record) {
  const discValue = record[fk.discriminatorField];
  const isKnownBlank = discValue in fk.discriminatorMap && fk.discriminatorMap[discValue] == null;
  return { category: fk.discriminatorMap[discValue], isKnownBlank };
}

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
    // Same convention as employee_drivers.Registration above - one Firebase
    // field, but the id it holds is only meaningful together with TruckType
    // (a head/tail/small truck's own id ranges overlap, so e.g. "5:..." can
    // mean a totally different physical truck depending on which). Confirmed
    // against real data: TruckType "หางรถใหญ่" rows' Registration plate text
    // matches truck_registration_tail.RegTail, NOT truck_registration.RegHead
    // for that same numeric id - the un-split version was silently resolving
    // every "หางรถใหญ่"/"รถเล็ก" row to the wrong physical truck (a
    // truck_registration row that happened to share the small id, since both
    // tables' ids start at 1) instead of leaving it unresolved.
    Registration: {
      splitByTruckType: {
        'หัวรถใหญ่': { target: 'truck_registration', field: 'RegistrationHead', column: 'registration_head', nameField: 'RegistrationHeadName', nameColumn: 'registration_head_name' },
        'หางรถใหญ่': { target: 'truck_registration_tail', field: 'RegistrationTail', column: 'registration_tail', nameField: 'RegistrationTailName', nameColumn: 'registration_tail_name' },
        'รถเล็ก': { target: 'truck_small', field: 'RegistrationSmall', column: 'registration_small', nameField: 'RegistrationSmallName', nameColumn: 'registration_small_name' },
      },
    },
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

// Every table name FK_FIELDS ever points at (target/discriminatorMap/
// splitByTruckType values, e.g. companypayment, truck_registration) -
// duplicate "id" values only risk linking a row to the WRONG target when
// something else can actually reference that id (see duplicateIdTables
// below). order/tickets/quotation/etc. have no other table pointing at them
// by id at all - a repeated id there (confirmed against real data: "id" on
// those tables is a small rotating ticket/trip counter that legitimately
// repeats hundreds of times, not a unique key) can never misdirect a link,
// so warning about it would be pure noise with nothing to act on.
function computeFkTargetTables() {
  const targets = new Set();
  for (const fields of Object.values(FK_FIELDS)) {
    for (const fk of Object.values(fields)) {
      if (fk.target) targets.add(fk.target);
      if (fk.splitByTruckType) {
        for (const dest of Object.values(fk.splitByTruckType)) targets.add(dest.target);
      }
    }
  }
  return targets;
}
const FK_TARGET_TABLES = computeFkTargetTables();

// Tables that intentionally live outside the Firebase-driven import cycle
// entirely - created once via their own SQL migration (backend/sql/), never
// populated from a Firebase export, and never dropped/touched by this file
// (only tables present in THIS JSON's tableNames ever get DROP TABLE'd
// below). Firebase will never have these nodes, so "this file doesn't have
// table X" is expected and permanent for them, not a sign anything's wrong -
// excluded from the missingTables warning below for exactly that reason.
const NON_FIREBASE_TABLES = new Set(['company_history', 'customer']);

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

// A handful of specific, individually-verified data-entry gaps in the real
// Firebase source that no general import rule can infer - each one was
// tracked down by cross-checking the row's OTHER fields (name/address/etc.)
// against every candidate target until exactly one match was found, the same
// way a human would. Applied automatically on every import (not just once)
// since Firebase itself still has the gap - without this, every fresh export
// re-introduces the exact same "1 reference unresolved" / "id ซ้ำ" warning
// this was already confirmed to fix. Each entry is defensive: only touches
// the record if it STILL looks exactly like it did when verified, so if
// Firebase is ever corrected at the source (or the row is deleted/renamed),
// this silently becomes a no-op instead of corrupting some other row that
// happens to reuse the same path.
const KNOWN_DATA_CORRECTIONS = [
  {
    // order/197 (row "No":197, "1:C.ขนุนทอง ก่อสร้าง"): CompanyName/CodeID/
    // Address are a byte-for-byte match to customers/smalltruck id=1 ("C.
    // ขนุนทอง ก่อสร้าง") - CustomerType was just never filled in on this one
    // (already-canceled) row, so TicketName had nothing to resolve against.
    path: ['order', '197'],
    field: 'CustomerType',
    expectedOld: '-',
    newValue: 'ตั๋วรถเล็ก',
  },
  // Duplicate "id" values (e.g. companypayment 343/355/357) are handled by
  // a general rule now - see deduplicateFkTargetIds below - not listed here
  // individually.
];

function applyKnownDataCorrections(data) {
  for (const { path, field, expectedOld, newValue } of KNOWN_DATA_CORRECTIONS) {
    const [table, rowKey] = path;
    const record = data?.[table]?.[rowKey];
    if (!record || record[field] !== expectedOld) {
      // Already fixed at the source, row renamed/deleted, or this is a
      // different export than the one this was verified against - leave it
      // alone rather than guess.
      continue;
    }
    record[field] = newValue;
    console.log(`[import] applied known correction: ${table}/${rowKey}.${field} ${JSON.stringify(expectedOld)} -> ${JSON.stringify(newValue)}`);
  }
}

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

  applyKnownDataCorrections(data);

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

  deduplicateFkTargetIds(tables);

  return { tables, warnings };
}

// A duplicate "id" within a table isn't hypothetical - confirmed in the real
// source data (e.g. companypayment) - and left alone it means whichever row
// FK resolution processes LAST always wins, silently making every earlier
// row sharing that id unreachable as a target. Instead of just warning,
// resolve it outright: the row Firebase key order puts FIRST keeps its
// original id, and anything after it sharing that id gets reassigned to a
// fresh one past the table's current highest id, so every row stays
// independently reachable and no manual decision is needed. Object key
// order for these integer-like Firebase keys ("342", "343", ...) is always
// ascending numeric per the JS spec, so "first" here matches "the row
// Firebase actually created first" for every table this has been checked
// against.
//
// Only applied to FK_TARGET_TABLES - order/tickets/etc. reuse "id" as a
// small rotating ticket/trip counter BY DESIGN (confirmed against real data:
// id=0 alone repeats 1000+ times there), and nothing ever references those
// tables by id, so reassigning one would invent a display number that never
// existed for zero benefit. "customers" is scoped per Category, matching
// CUSTOMER_CATEGORIES - ids there are only unique within one category, not
// across all 5.
function deduplicateFkTargetIds(tables) {
  for (const [table, rows] of Object.entries(tables)) {
    if (!FK_TARGET_TABLES.has(table)) continue;
    const isCustomers = table === 'customers';

    const seenByScope = {}; // scope -> Set of ids already claimed
    const nextFreshIdByScope = {}; // scope -> next id past the ORIGINAL max
    for (const { record } of rows) {
      if (typeof record.id !== 'number') continue;
      const scope = isCustomers ? record.Category : '_';
      if (!(scope in nextFreshIdByScope) || record.id >= nextFreshIdByScope[scope]) {
        nextFreshIdByScope[scope] = record.id + 1;
      }
    }

    for (const { record } of rows) {
      if (typeof record.id !== 'number') continue;
      const scope = isCustomers ? record.Category : '_';
      const seen = (seenByScope[scope] ??= new Set());
      if (seen.has(record.id)) {
        const freshId = nextFreshIdByScope[scope]++;
        console.log(`[import] reassigned duplicate id: ${table}${isCustomers ? ` (${scope})` : ''} id ${record.id} -> ${freshId}`);
        record.id = freshId;
      }
      seen.add(record.id);
    }
  }
}

export function buildImportPlan(data) {
  const { tables, warnings } = parseFirebaseTables(data);
  const tableNames = Object.keys(tables).sort();

  // A table this database already knows about but that isn't in THIS JSON
  // at all is left completely untouched below (not dropped, not recreated) -
  // flag that explicitly rather than let it pass silently, since "ทับข้อมูล
  // เดิมทั้งหมด" reads as "replace everything" and a JSON missing a table
  // (an incomplete export, a renamed node) is easy to miss otherwise.
  const missingTables = Object.keys(getManifest()).filter(
    (t) => !tableNames.includes(t) && !NON_FIREBASE_TABLES.has(t)
  );
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
  // A duplicate "id" within an FK_TARGET_TABLES table is already resolved by
  // deduplicateFkTargetIds in parseFirebaseTables above (every row is
  // guaranteed independently reachable by the time this runs), so nothing
  // left to detect or warn about here.
  for (const [table, rows] of Object.entries(tables)) {
    uuidByTableRowKey[table] = {};
    uuidByTableId[table] = {};
    for (const { rowKey, record } of rows) {
      const uuid = crypto.randomUUID();
      uuidByTableRowKey[table][rowKey] = uuid;
      if (typeof record.id !== 'number') continue;
      if (table === 'customers') {
        (uuidByTableId[table][record.Category] ??= {})[record.id] = uuid;
      } else {
        uuidByTableId[table][record.id] = uuid;
      }
    }
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
  let companyHasHistoryColumn = false;

  for (const tableName of tableNames) {
    const rows = tables[tableName];
    const columns = classifyColumns(tableName, rows);
    const qTable = quoteIdent(tableName);
    if (tableName === 'company' && columns.some((c) => c.column === 'history')) {
      companyHasHistoryColumn = true;
    }

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
              let isKnownBlank = false;
              if (parsed && col.fk.discriminatorField) {
                const resolved = resolveDiscriminatorCategory(col.fk, record);
                isKnownBlank = resolved.isKnownBlank;
                targetUuid = resolved.category ? uuidByTableId[col.fk.target]?.[resolved.category]?.[parsed.id] : undefined;
              } else if (parsed) {
                targetUuid = uuidByTableId[col.fk.target]?.[parsed.id];
              }
              // parsed.id === 0 is the source app's own "nothing selected"
              // placeholder (a <select> defaulting to value 0, always paired
              // with a name like "ไม่มี"/"ว่าง") - every target table's real
              // ids start at 1 (or, for the couple that legitimately use 0,
              // targetUuid above already resolved and this branch never
              // runs), so id 0 can never be a genuine dangling reference.
              // isKnownBlank is the discriminator-field equivalent (e.g.
              // "ตั๋วเปล่า"). Only count/warn about ids that used to point at
              // a real row.
              if (parsed && !targetUuid && parsed.id !== 0 && !isKnownBlank) {
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
              // See the id-0 comment above - same "nothing selected" sentinel.
              if (matches && parsed && !targetUuid && parsed.id !== 0) {
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

  // company_history has a real FK into company("uuid") (see NON_FIREBASE_TABLES
  // above for why it exists outside the Firebase cycle at all) - and "company"
  // itself just got unconditionally DROP TABLE ... CASCADE'd above like every
  // other Firebase table, which silently takes company_history down with it
  // every single time, not just once. Rebuilding it fresh here, in the same
  // transaction, right after company's new rows (and their new uuids) exist,
  // is what actually makes it survive a re-import - a separate one-off
  // migration run once and never again would just keep losing this table on
  // every future import forever (confirmed happening in practice). Fully
  // re-derivable from company.history with no manual matching needed (unlike
  // trying to reconnect an already-detached company_history row after the
  // fact, which risks linking a history entry to the wrong company - see the
  // in-code comment history on this function), so there's nothing to lose by
  // rebuilding it every time.
  if (companyHasHistoryColumn) {
    sqlParts.push('DROP TABLE IF EXISTS "company_history" CASCADE;');
    sqlParts.push(`CREATE TABLE "company_history" (
  "uuid" UUID PRIMARY KEY,
  "row_key" TEXT,
  "company" UUID REFERENCES "company" ("uuid"),
  "name" TEXT,
  "card_id" TEXT,
  "address" JSONB,
  "date_start" TEXT,
  "date_end" TEXT
);`);
    sqlParts.push(`INSERT INTO "company_history" ("uuid", "row_key", "company", "name", "card_id", "address", "date_start", "date_end")
SELECT gen_random_uuid(), gen_random_uuid()::text, c."uuid", entry ->> 'Name', entry ->> 'CardID', entry -> 'Address', entry ->> 'DateStart', entry ->> 'DateEnd'
FROM "company" c, jsonb_array_elements(c."history") AS entry
WHERE c."history" IS NOT NULL AND jsonb_typeof(c."history") = 'array';`);
    manifest.company_history = {
      primaryKey: 'uuid',
      rowCount: null, // varies with company.history content, not known ahead of running the SQL above
      columns: [
        { field: 'Company', column: 'company', type: 'UUID' },
        { field: 'Name', column: 'name', type: 'TEXT' },
        { field: 'CardID', column: 'card_id', type: 'TEXT' },
        { field: 'Address', column: 'address', type: 'JSONB' },
        { field: 'DateStart', column: 'date_start', type: 'TEXT' },
        { field: 'DateEnd', column: 'date_end', type: 'TEXT' },
      ],
    };
  } else {
    // The export this run genuinely has no history data on any company row
    // (company still gets dropped above regardless) - nothing to rebuild,
    // and claiming the table exists in the manifest when it doesn't would
    // break assertValidTable for every route that reads it.
    delete manifest.company_history;
  }

  // customer has no FK into any Firebase table, so it never gets touched by
  // the DROP TABLE ... CASCADE above - IF NOT EXISTS here is just a one-time
  // safety net for a database that has never had it created at all yet.
  sqlParts.push(`CREATE TABLE IF NOT EXISTS "customer" (
  "uuid" UUID PRIMARY KEY,
  "row_key" TEXT,
  "name" TEXT,
  "address" TEXT,
  "lat" TEXT,
  "lng" TEXT,
  "credit" TEXT,
  "credit_time" TEXT,
  "debt" TEXT,
  "id_card" TEXT,
  "phone" TEXT,
  "id" NUMERIC
);`);
  if (!manifest.customer) {
    manifest.customer = {
      primaryKey: 'uuid',
      rowCount: 0,
      columns: [
        { field: 'Name', column: 'name', type: 'TEXT' },
        { field: 'Address', column: 'address', type: 'TEXT' },
        { field: 'Lat', column: 'lat', type: 'TEXT' },
        { field: 'Lng', column: 'lng', type: 'TEXT' },
        { field: 'Credit', column: 'credit', type: 'TEXT' },
        { field: 'CreditTime', column: 'credit_time', type: 'TEXT' },
        { field: 'Debt', column: 'debt', type: 'TEXT' },
        { field: 'IdCard', column: 'id_card', type: 'TEXT' },
        { field: 'Phone', column: 'phone', type: 'TEXT' },
        { field: 'id', column: 'id', type: 'NUMERIC' },
      ],
    };
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

    // Any duplicate "id" among these rows within THIS batch is already
    // resolved by deduplicateFkTargetIds (runs on every row in
    // parseFirebaseTables, before newRows is filtered down to just the
    // ones this table doesn't have yet) - a collision against an id an
    // EARLIER import already committed to Postgres is a separate, rarer
    // case this doesn't cover, since resolving that would need reassigning
    // a live row's id after the fact.
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
    let isKnownBlank = false;
    if (fk.discriminatorField) {
      const resolved = resolveDiscriminatorCategory(fk, record);
      isKnownBlank = resolved.isKnownBlank;
      const category = resolved.category;
      targetUuid = (category && targetFresh[category]?.[parsed.id]) || (category && targetExisting[category]?.[parsed.id]);
    } else {
      targetUuid = targetFresh[parsed.id] ?? targetExisting[parsed.id];
    }
    // See the id-0/isKnownBlank comments in buildImportPlan above - neither
    // is a genuine dangling reference.
    if (!targetUuid && parsed.id !== 0 && !isKnownBlank) {
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
