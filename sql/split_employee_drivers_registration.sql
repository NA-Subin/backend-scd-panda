-- employee_drivers.Registration was set up during the original migration to
-- FK into truck_registration only, but the original Firebase app always
-- used this one field to hold EITHER a truck_registration id (TruckType =
-- "รถใหญ่") OR a truck_small id (TruckType = "รถเล็ก") - Firebase never
-- validated which, so it "worked" by convention alone. Postgres can't make
-- one FK column point at two different tables, so this splits the small-
-- truck case into its own column pair instead.
--
-- No backfill needed: every current employee_drivers row with
-- TruckType = 'รถเล็ก' already has Registration = NULL (confirmed against
-- the live database - the shared-column write for a small truck has been
-- silently failing the FK constraint since the Postgres cutover, so there
-- was never a successful small-truck assignment to migrate).
--
-- Run with:
--   psql -h localhost -p 5432 -U postgres -d scd_panda -f backend/sql/split_employee_drivers_registration.sql

SET client_encoding = 'UTF8';
SET search_path TO public;

BEGIN;

ALTER TABLE employee_drivers ADD COLUMN registration_small UUID;
ALTER TABLE employee_drivers ADD COLUMN registration_small_name TEXT;
ALTER TABLE employee_drivers
  ADD CONSTRAINT employee_drivers_registration_small_fkey
  FOREIGN KEY (registration_small) REFERENCES truck_small (uuid);

COMMIT;
