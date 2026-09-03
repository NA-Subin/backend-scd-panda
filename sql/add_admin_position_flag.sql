-- Adds a real "admin" permission to the positions table, alongside the
-- existing DriverData/BasicData/OprerationData/FinancialData/ReportData/
-- SmallTruckData/BigTruckData/GasStationData flags - same 0/1 NUMERIC
-- convention, toggled per-position from the settings page just like the
-- others. Used to gate the two Firebase-import buttons on /choose (both the
-- destructive full-replace one and the new additive one) to admins only,
-- both in the UI and, more importantly, on the backend routes themselves.

SET client_encoding = 'UTF8';
SET search_path TO scd_panda, public;

BEGIN;

ALTER TABLE positions ADD COLUMN admin_data NUMERIC DEFAULT 0;

COMMIT;
