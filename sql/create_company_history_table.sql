-- SUPERSEDED - kept only for historical reference, no need to run this
-- manually on a fresh install anymore. buildImportPlan (src/importData.js)
-- now rebuilds company_history automatically from company.history as part
-- of every full "นำเข้าข้อมูล JSON" import (see the companyHasHistoryColumn
-- block there) - this table used to get silently dropped every time
-- (company_history has a real FK into company, and company itself gets
-- DROP TABLE ... CASCADE'd on every re-import, which cascaded the drop),
-- which this script alone could never fix since it only ever ran once.
-- Running this script now would just insert a second, duplicate copy of
-- each history row (harmless, but pointless) on top of what the import
-- already rebuilt - safe to skip entirely.
--
-- Moves company edit history out of company.history (a JSONB blob embedded
-- on the company row) into its own company_history table - a proper append-
-- only log instead of a JSONB array that has to be read-merge-written on
-- every edit (the same shape-corruption risk already seen with
-- depot_stock.Products/depot_gas_stations.Products elsewhere in this app:
-- a JS object spread over a Firebase-array-shaped JSONB value can silently
-- turn back into a sparse array with null holes).
--
-- Run with:
--   psql -h localhost -p 5432 -U postgres -d scd_panda -f backend/sql/create_company_history_table.sql

SET search_path TO scd_panda, public;

BEGIN;

CREATE TABLE company_history (
  uuid UUID PRIMARY KEY,
  row_key TEXT,
  company UUID REFERENCES company (uuid),
  name TEXT,
  card_id TEXT,
  address JSONB,
  date_start TEXT,
  date_end TEXT
);

-- Backfill from the existing company.history JSONB arrays (verified live:
-- 2 of 4 companies currently have exactly 1 history entry each).
INSERT INTO company_history (uuid, row_key, company, name, card_id, address, date_start, date_end)
SELECT
  gen_random_uuid(),
  gen_random_uuid()::text,
  c.uuid,
  entry ->> 'Name',
  entry ->> 'CardID',
  entry -> 'Address',
  entry ->> 'DateStart',
  entry ->> 'DateEnd'
FROM company c, jsonb_array_elements(c.history) AS entry
WHERE c.history IS NOT NULL
  AND jsonb_typeof(c.history) = 'array';

ALTER TABLE company DROP COLUMN history;

COMMIT;
