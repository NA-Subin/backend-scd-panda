-- One-time bootstrap for a brand-new, completely empty database. Creates just
-- the two tables /api/auth/login and the admin-tools UI actually need
-- (positions, employee_officers) and seeds ONE temporary admin account, so a
-- fresh install can log in through the normal web UI immediately and use the
-- existing "นำเข้าข้อมูล JSON" button on the "เลือกเมนู" page instead of
-- running a separate import script from the command line.
--
-- Login: user "admin", password "ChangeMe123!" (the hash below is that
-- password, bcrypt cost 10 - generated once with `node -e
-- "console.log(require('bcryptjs').hashSync('ChangeMe123!', 10))"`, matching
-- how every other password in this app is stored).
--
-- After logging in with this account, use "นำเข้าข้อมูล JSON (ทับข้อมูลเดิม
-- ทั้งหมด)" to import the latest Firebase export. That import DROPS and
-- recreates every table - including these two - so the temporary account
-- above disappears in the same step, and you log back in with a real
-- account from the imported data. (If you instead use "เพิ่มข้อมูลใหม่ (ไม่
-- ลบของเดิม)", these two tables and the temporary account are NOT touched
-- and will stay in the database - remove the temporary officer row by hand
-- afterwards if you go that route.)
--
-- Run with:
--   psql -h localhost -p 5432 -U postgres -d scd_panda -f backend/sql/bootstrap-admin.sql

SET search_path TO scd_panda, public;

BEGIN;

CREATE TABLE positions (
  uuid UUID PRIMARY KEY,
  row_key TEXT,
  admin_data NUMERIC,
  basic_data NUMERIC,
  big_truck_data NUMERIC,
  driver_data NUMERIC,
  financial_data NUMERIC,
  gas_station_data NUMERIC,
  name TEXT,
  opreration_data NUMERIC,
  report_data NUMERIC,
  small_truck_data NUMERIC,
  id NUMERIC
);

CREATE TABLE employee_officers (
  uuid UUID PRIMARY KEY,
  row_key TEXT,
  name TEXT,
  password TEXT,
  phone TEXT,
  position UUID,
  position_name TEXT,
  rights TEXT,
  "user" TEXT,
  id NUMERIC,
  gas_station TEXT
);

INSERT INTO positions (uuid, row_key, admin_data, name, id)
VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 1, 'ผู้ดูแลระบบชั่วคราว (Bootstrap)', 1);

INSERT INTO employee_officers (uuid, row_key, name, password, position, position_name, "user", id)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000002',
  'ผู้ดูแลระบบชั่วคราว',
  '$2a$10$6fkJp5KYkA5iO7ooUxdLq.CYC6cz.BDEwR8Uiz2EypD1TE4xF1qNK',
  '00000000-0000-4000-8000-000000000001',
  'ผู้ดูแลระบบชั่วคราว (Bootstrap)',
  'admin',
  1
);

COMMIT;
