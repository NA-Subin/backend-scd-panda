const express = require('express');
const { pool } = require('../db');
const { BASIC_DATA_MAP, selectColumnsSql } = require('../schema-manifest');
const { rowsToKeyedObject } = require('../rowShape');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const keys = Object.keys(BASIC_DATA_MAP);
    const results = await Promise.all(
      keys.map(async (key) => {
        const table = BASIC_DATA_MAP[key];
        const { rows } = await pool.query(`SELECT ${selectColumnsSql(table)} FROM "${table}"`);
        return [key, rowsToKeyedObject(rows)];
      })
    );
    res.json(Object.fromEntries(results));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
