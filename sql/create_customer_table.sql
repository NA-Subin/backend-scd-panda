-- Creates the "customer" table backing the /customer page (Customer.js,
-- InsertData.js, UpdateCustomer.js). This is a generic customer list,
-- separate from the categorized "customers" table (tickets/gasstations/
-- bigtruck/smalltruck/transports) - it was never migrated from Firebase
-- because the original RTDB export used for the cutover didn't include
-- a "/customer" node, and no fresher export has had one either, so there
-- is no existing data to backfill here. This just creates the empty
-- table so the page (previously crashing, then merely non-functional)
-- has somewhere real to read from and write to going forward.
--
-- Run with:
--   psql -h localhost -p 5432 -U postgres -d scd_panda -f backend/sql/create_customer_table.sql

SET search_path TO scd_panda, public;

BEGIN;

CREATE TABLE customer (
  uuid UUID PRIMARY KEY,
  row_key TEXT,
  name TEXT,
  address TEXT,
  lat TEXT,
  lng TEXT,
  credit TEXT,
  credit_time TEXT,
  debt TEXT,
  id_card TEXT,
  phone TEXT,
  id NUMERIC
);

COMMIT;
