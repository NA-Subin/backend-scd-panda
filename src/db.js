require('dotenv').config();
const { Pool, types } = require('pg');

// node-postgres returns NUMERIC (OID 1700) as strings by default to avoid
// precision loss; the original Firebase data was plain JS numbers, so parse
// them back to numbers to match what the frontend expects.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  options: `-c search_path=${process.env.PGSCHEMA}`,
});

module.exports = { pool };
