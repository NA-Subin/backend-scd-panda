-- transfermoney and invoice both have two fields that were never migrated to
-- real FKs during the original Firebase->Postgres import, even though every
-- other table with the same "id:Name" shape was correctly split into a real
-- UUID FK + a companion "{Field}Name" text column:
--
--   transfermoney.ticket_name / invoice.ticket_name
--     -> should point into "customers", discriminated by ticket_type (same
--        polymorphic id used by tickets.TicketName/order.TicketName - see
--        TICKET_NAME_DISCRIMINATOR in src/importData.js; the id is only
--        unique within one customers.category, and ticket_type says which).
--   transfermoney.transport / invoice.transport
--     -> should point into "company" (a plain, non-discriminated id).
--
-- This was a gap in the original FK_FIELDS mapping (neither table was listed
-- there at all), not a data problem - every row resolves cleanly. Verified
-- via a dry run before writing this:
--   transfermoney.ticket_name: 973/973 rows resolve against customers.
--   invoice.ticket_name:       609/609 rows resolve against customers.
--   invoice.transport:         609/609 rows resolve against company.
--   transfermoney.transport:   893/973 resolve against company, the other 80
--                              are blank strings (no transport company chosen
--                              yet) which correctly become NULL, not a miss.
--
-- Left unfixed, every frontend comparison between a ticket/order's real
-- TicketName UUID and these tables' composite strings silently fails, so
-- incoming-payment totals always compute as 0 and every bill looks
-- perpetually unpaid in the reports.

SET client_encoding = 'UTF8';
SET search_path TO public;

BEGIN;

ALTER TABLE transfermoney ADD COLUMN ticket_name_name TEXT;
ALTER TABLE transfermoney ADD COLUMN transport_name TEXT;
ALTER TABLE invoice ADD COLUMN ticket_name_name TEXT;
ALTER TABLE invoice ADD COLUMN transport_name TEXT;

-- Each {Field}Name companion gets the same source text the original importer
-- would have used: the name half of this row's OWN original composite
-- string, not a fresh lookup - stays byte-for-byte consistent with how
-- tickets.ticket_name_name / order.ticket_name_name were populated.

UPDATE transfermoney t
SET ticket_name_name = trim(substring(t.ticket_name from position(':' in t.ticket_name) + 1)),
    ticket_name = c.uuid::text
FROM customers c
WHERE c.category = CASE t.ticket_type
        WHEN 'ตั๋วรถใหญ่' THEN 'bigtruck'
        WHEN 'ตั๋วรับจ้างขนส่ง' THEN 'transports'
        WHEN 'ตั๋วรถเล็ก' THEN 'smalltruck'
        WHEN 'ตั๋วน้ำมัน' THEN 'tickets'
        WHEN 'ตั๋วปั้ม' THEN 'gasstations'
      END
  AND c.id = (split_part(t.ticket_name, ':', 1))::int;

UPDATE transfermoney t
SET transport_name = trim(substring(t.transport from position(':' in t.transport) + 1)),
    transport = co.uuid::text
FROM company co
WHERE t.transport <> ''
  AND co.id = (split_part(t.transport, ':', 1))::int;

UPDATE invoice i
SET ticket_name_name = trim(substring(i.ticket_name from position(':' in i.ticket_name) + 1)),
    ticket_name = c.uuid::text
FROM customers c
WHERE c.category = CASE i.ticket_type
        WHEN 'ตั๋วรถใหญ่' THEN 'bigtruck'
        WHEN 'ตั๋วรับจ้างขนส่ง' THEN 'transports'
        WHEN 'ตั๋วรถเล็ก' THEN 'smalltruck'
        WHEN 'ตั๋วน้ำมัน' THEN 'tickets'
        WHEN 'ตั๋วปั้ม' THEN 'gasstations'
      END
  AND c.id = (split_part(i.ticket_name, ':', 1))::int;

UPDATE invoice i
SET transport_name = trim(substring(i.transport from position(':' in i.transport) + 1)),
    transport = co.uuid::text
FROM company co
WHERE i.transport <> ''
  AND co.id = (split_part(i.transport, ':', 1))::int;

ALTER TABLE transfermoney ALTER COLUMN ticket_name TYPE UUID USING ticket_name::uuid;
ALTER TABLE transfermoney ALTER COLUMN transport TYPE UUID USING NULLIF(transport, '')::uuid;
ALTER TABLE invoice ALTER COLUMN ticket_name TYPE UUID USING ticket_name::uuid;
ALTER TABLE invoice ALTER COLUMN transport TYPE UUID USING NULLIF(transport, '')::uuid;

ALTER TABLE transfermoney
  ADD CONSTRAINT transfermoney_ticket_name_fkey
  FOREIGN KEY (ticket_name) REFERENCES customers (uuid);
ALTER TABLE transfermoney
  ADD CONSTRAINT transfermoney_transport_fkey
  FOREIGN KEY (transport) REFERENCES company (uuid);
ALTER TABLE invoice
  ADD CONSTRAINT invoice_ticket_name_fkey
  FOREIGN KEY (ticket_name) REFERENCES customers (uuid);
ALTER TABLE invoice
  ADD CONSTRAINT invoice_transport_fkey
  FOREIGN KEY (transport) REFERENCES company (uuid);

COMMIT;
