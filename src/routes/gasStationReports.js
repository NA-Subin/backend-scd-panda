import { Elysia } from 'elysia';
import { pool } from '../db.js';
import { selectColumnsSql } from '../schema-manifest.js';
import { rowsToKeyedObject } from '../rowShape.js';
import { requireAuth } from '../authMiddleware.js';

// ADDITIVE endpoint - does not replace or modify the existing generic
// GET /api/depot_gas_stations (which still returns the full row including
// the multi-megabyte Report history, unchanged, for any other consumer).
//
// depot_gas_stations.Report is an ever-growing per-station JSONB history
// (year -> month -> day -> {Products, Truck}), observed up to ~1.6MB per row
// (~9MB across all 8 stations combined) - GasStationsDetail.js was fetching
// and reprocessing the ENTIRE thing on every render/poll just to compute the
// currently-selected date's numbers, which is what made that page slow/janky.
//
// This endpoint runs that exact same computation server-side (ported
// verbatim from GasStationsDetail.js's getStationReportsArray/prepareData/
// merged-Truck logic - see gasStationReportCalc.js) and returns only the
// small, already-resolved result for the one requested date, instead of
// shipping the raw history to the browser at all.
//
// IMPORTANT: this must stay byte-for-byte equivalent to the frontend
// calculation it replaces - see scripts/verify-gas-station-reports.js, which
// this was checked against for every station across the full real report
// history before the frontend was ever switched to call this.
import {
  getStationReportsArray,
  prepareData,
  buildMerged,
  parseDateParam,
} from '../gasStationReportCalc.js';

export const gasStationReportsRoutes = new Elysia().get(
  '/api/depot_gas_stations/reports',
  async ({ query, headers, set }) => {
    requireAuth(headers);

    const selectedDate = parseDateParam(query.date);
    if (!selectedDate) {
      set.status = 400;
      return { error: 'query param "date" is required, format DD-MM-YYYY' };
    }

    // ORDER BY id explicitly - a plain SELECT with no ORDER BY has no
    // guaranteed row order in Postgres, and getStationReportsArray's
    // "isFirst" (which pump of a 2-pump stock carries Capacity/Squeeze/
    // PeriodDisplay/downhole) depends entirely on array order. Without this,
    // row order can silently drift between queries/deploys, flipping which
    // pump is treated as "first" and producing wrong Squeeze/PeriodDisplay/
    // aggregate totals for BOTH pumps of any 2-pump stock - found via a
    // live old-vs-new comparison where "แม่โจ้" (id 1 & 3) disagreed on which
    // pump was first. id ascending matches the original Firebase system's
    // natural (push-key/insertion) order, so it's the correct, stable choice.
    const { rows: stationRowsRaw } = await pool.query(
      `SELECT ${selectColumnsSql('depot_gas_stations')} FROM "depot_gas_stations" ORDER BY id ASC`
    );
    const { rows: stockRowsRaw } = await pool.query(
      `SELECT ${selectColumnsSql('depot_stock')} FROM "depot_stock" ORDER BY id ASC`
    );

    const gasStationOil = Object.values(rowsToKeyedObject(stationRowsRaw));
    const stocks = Object.values(rowsToKeyedObject(stockRowsRaw));

    const rawData = getStationReportsArray(stocks, gasStationOil, selectedDate, 800);
    const prepared = prepareData(rawData);
    const reports = buildMerged(prepared, gasStationOil, selectedDate);

    // Lightweight per-station metadata (everything except the heavy Report
    // history) for the rest of the page - name/address/stock/products list/etc.
    const stations = gasStationOil.map(({ Report, ...rest }) => rest);

    return { stations, stocks, reports };
  }
);
