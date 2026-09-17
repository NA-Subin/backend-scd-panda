-- report/Report.js matched each customer-billing-period group to its
-- transfermoney (ยอดค้างโอน) records via a re-derived string key
-- ("${monthKey}_${period}"), built from the customer's CURRENT CreditTime
-- setting every render. This breaks whenever CreditTime is edited later,
-- and a follow-up attempt to match by TicketNo (frontend session, later
-- reverted) turned out to rely on nothing but the row's position in an
-- ORDER-BY-less query result - not a stable identity at all.
--
-- Verified with a dry run against live data: of 973 transfermoney rows,
-- 736 (76%) have a blank `month` value entirely and can never be
-- reconstructed; another 4 have a "ไม่ระบุช่วง" fallback with no day
-- embedded (also unreconstructable); 233 (24%) DO carry enough
-- information to reconstruct their real billing-period boundaries:
--   - 174 rows: "YYYY-MM_ช่วงที่ N" (needs the customer's current
--     CreditTime, same assumption the old code already made)
--   - 59 rows: "YYYY-MM_ไม่ระบุช่วง_<creditTime>_<No>_<day>" (fully
--     self-contained - the creditTime and day are frozen in the string
--     itself, so this reconstruction doesn't depend on anything
--     mutable)
--
-- This migration adds two new columns that store the billing period's
-- actual DateStart/DateEnd (not to be confused with the existing
-- `date_start` column, which records the date the PAYMENT itself was
-- entered - a different concept). Going forward, the frontend writes
-- these directly from the group being paid against, so new records
-- match reliably regardless of row order or later CreditTime edits.
-- The two backfills below recover what's recoverable for historical
-- rows; the remaining 740 unreconstructable rows are left NULL, same
-- as they've effectively always been (never reliably matchable).

SET client_encoding = 'UTF8';
SET search_path TO public;

BEGIN;

ALTER TABLE transfermoney ADD COLUMN period_start TEXT;
ALTER TABLE transfermoney ADD COLUMN period_end TEXT;

-- Backfill 1: "YYYY-MM_ช่วงที่ N" using each row's customer's CURRENT
-- credit_time (the same live-lookup assumption the old matching logic
-- already relied on - not a new source of fragility, just preserved).
UPDATE transfermoney t
SET period_start = to_char(bounds.start_date, 'DD/MM/YYYY'),
    period_end = to_char(bounds.end_date, 'DD/MM/YYYY')
FROM (
  SELECT
    t2.id,
    (split_part(t2.month, '_', 1) || '-01')::date AS month_start,
    split_part(t2.month, '_', 2) AS period_label,
    NULLIF(c.credit_time, '')::int AS credit_time
  FROM transfermoney t2
  LEFT JOIN customers c ON c.uuid = t2.ticket_name
  WHERE t2.month ~ '^[0-9]{4}-[0-9]{2}_ช่วงที่ [1-3]$'
) src
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN src.credit_time = 10 AND src.period_label = 'ช่วงที่ 1' THEN src.month_start
      WHEN src.credit_time = 10 AND src.period_label = 'ช่วงที่ 2' THEN src.month_start + 10
      WHEN src.credit_time = 10 AND src.period_label = 'ช่วงที่ 3' THEN src.month_start + 20
      WHEN src.credit_time = 15 AND src.period_label = 'ช่วงที่ 1' THEN src.month_start
      WHEN src.credit_time = 15 AND src.period_label = 'ช่วงที่ 2' THEN src.month_start + 15
      WHEN src.credit_time IN (0, 30) AND src.period_label = 'ช่วงที่ 1' THEN src.month_start
    END AS start_date,
    CASE
      WHEN src.credit_time = 10 AND src.period_label = 'ช่วงที่ 1' THEN src.month_start + 9
      WHEN src.credit_time = 10 AND src.period_label = 'ช่วงที่ 2' THEN src.month_start + 19
      WHEN src.credit_time = 10 AND src.period_label = 'ช่วงที่ 3' THEN (src.month_start + interval '1 month' - interval '1 day')::date
      WHEN src.credit_time = 15 AND src.period_label = 'ช่วงที่ 1' THEN src.month_start + 14
      WHEN src.credit_time = 15 AND src.period_label = 'ช่วงที่ 2' THEN (src.month_start + interval '1 month' - interval '1 day')::date
      WHEN src.credit_time IN (0, 30) AND src.period_label = 'ช่วงที่ 1' THEN (src.month_start + interval '1 month' - interval '1 day')::date
    END AS end_date
) bounds
WHERE t.id = src.id AND bounds.start_date IS NOT NULL AND bounds.end_date IS NOT NULL;

-- Backfill 2: "YYYY-MM_ไม่ระบุช่วง_<creditTime>_<No>_<day>" - fully
-- self-contained, no customer lookup needed.
UPDATE transfermoney t
SET period_start = to_char(src.start_date, 'DD/MM/YYYY'),
    period_end = to_char(src.start_date + src.credit_time, 'DD/MM/YYYY')
FROM (
  SELECT
    id,
    (split_part(month, '_', 1) || '-' || lpad(split_part(month, '_', 5), 2, '0'))::date AS start_date,
    split_part(month, '_', 3)::int AS credit_time
  FROM transfermoney
  WHERE month ~ '^[0-9]{4}-[0-9]{2}_ไม่ระบุช่วง_[0-9]+_[0-9]+_[0-9]+$'
) src
WHERE t.id = src.id;

COMMIT;
