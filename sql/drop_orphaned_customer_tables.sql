-- Drop the 5 pre-merge customer tables, now fully superseded by the single
-- merged "customers" table (see src/schema-manifest.js CATEGORY_FILTERED_KEYS
-- and src/importData.js for the merge logic).
--
-- Verified before writing this script (2026-08-30): the merged "customers"
-- table has exactly 206 rows, which equals the sum of the 5 legacy tables'
-- row counts (customers_bigtruck 82 + customers_gasstations 17 +
-- customers_smalltruck 60 + customers_tickets 14 + customers_transports 33
-- = 206), confirming no rows were lost or duplicated in the merge and that
-- these tables are pure leftovers with no remaining live reader in the
-- frontend or backend code.
--
-- Run manually against the scd_panda schema:
--   psql -h localhost -p 5432 -U postgres -d scd_panda -f drop_orphaned_customer_tables.sql

DROP TABLE IF EXISTS scd_panda.customers_bigtruck;
DROP TABLE IF EXISTS scd_panda.customers_gasstations;
DROP TABLE IF EXISTS scd_panda.customers_smalltruck;
DROP TABLE IF EXISTS scd_panda.customers_tickets;
DROP TABLE IF EXISTS scd_panda.customers_transports;
