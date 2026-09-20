// Server-side port of the gas-station daily report calculation that used to
// run entirely in the browser, inside
// frontend/src/components/depots/gasstation/GasStationsDetail.js
// (getStationReportsArray, prepareData, the Truck-merging block, and their
// helpers). Ported as literally as possible - same variable names, same
// branch order, same edge-case handling - specifically so it can be verified
// byte-for-byte against the original client-side output (see
// scripts/verify-gas-station-reports.js) rather than trusted as a
// from-scratch reimplementation of financial/stock math.
//
// The one structural difference from the original: dates are plain
// {y, m, d} integer objects instead of dayjs instances, computed with UTC
// epoch-ms arithmetic (toUTCms/fromUTCms below) instead of a date library -
// avoids adding a dependency for what's just "subtract one day" and "compare
// two calendar dates", and sidesteps any local-timezone DST edge cases dayjs
// would otherwise need a plugin for.

const DAY_MS = 24 * 60 * 60 * 1000;

function toUTCms({ y, m, d }) {
  return Date.UTC(y, m - 1, d);
}

function fromUTCms(ms) {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function subtractDay(date, n = 1) {
  return fromUTCms(toUTCms(date) - n * DAY_MS);
}

function isAfter(a, b) {
  return toUTCms(a) > toUTCms(b);
}

function isSameOrAfter(a, b) {
  return toUTCms(a) >= toUTCms(b);
}

function formatDateThai({ y, m, d }) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d)}/${pad(m)}/${y}`;
}

// Accepts "DD-MM-YYYY" (query-string friendly) or "DD/MM/YYYY". Returns null
// for anything unparseable so the route can 400 instead of silently
// computing against an invalid date.
export function parseDateParam(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return { y, m: mo, d };
}

function getLastReportDate(reportObj) {
  if (!reportObj) return null;
  let latest = null;
  for (const y of Object.keys(reportObj)) {
    const yearObj = reportObj[y];
    if (!yearObj) continue;
    for (const m of Object.keys(yearObj)) {
      const monthObj = yearObj[m];
      if (!monthObj) continue;
      for (const d of Object.keys(monthObj)) {
        // Object.keys() on an array still returns indices holding an
        // explicit null (only true holes are skipped) - a stray null day
        // entry would otherwise get counted as "this station's most recent
        // report date", pointing the Squeeze/EstimateSell reference lookup
        // at an empty day instead of the real last one.
        if (monthObj[d] == null) continue;
        const cand = { y: Number(y), m: Number(m), d: Number(d) };
        if (!latest || isAfter(cand, latest)) latest = cand;
      }
    }
  }
  return latest;
}

function hasValidTruck(truckArray) {
  if (!Array.isArray(truckArray) || truckArray.length === 0) return false;
  return truckArray.some((t) => typeof t?.Truck === 'string' && t.Truck.trim() !== '');
}

function findYesterdayTruck(report, selectedDate) {
  const prev = subtractDay(selectedDate, 1);
  return report?.[prev.y]?.[prev.m]?.[prev.d]?.Truck ?? [];
}

function getYesterdayTotal(todayTruck, yesterdayTruck) {
  if (!Array.isArray(yesterdayTruck)) return 0;
  const match = yesterdayTruck.find((yt) => yt.Truck === todayTruck.Truck);
  if (!match) return 0;
  return Number(match.Price || 0) + Number(match.Volume || 0);
}

function isEmptyValue(v) {
  return v === undefined || v === null || Number(v) === 0;
}

// Walks backward from (but not including) selectedDate looking for the most
// recent day with a real Truck entry - can legitimately reach back weeks if
// a station had a reporting gap (confirmed against real data: gaps up to 12
// days occur, e.g. around New Year), so this has to search full history, not
// a fixed window.
function findLatestValidTruck(report, selectedDate) {
  if (!report) return [];
  for (const yr of Object.keys(report).sort((a, b) => b - a)) {
    if (!report[yr]) continue;
    for (const mon of Object.keys(report[yr]).sort((a, b) => b - a)) {
      if (!report[yr][mon]) continue;
      for (const day of Object.keys(report[yr][mon]).sort((a, b) => b - a)) {
        const currDate = { y: Number(yr), m: Number(mon), d: Number(day) };
        if (isSameOrAfter(currDate, selectedDate)) continue;

        const truckArray = report[yr][mon][day]?.Truck ?? [];
        if (!hasValidTruck(truckArray)) continue;

        return truckArray.map((t, idx) => ({
          id: idx,
          Truck: t.Truck ?? '',
          Price: Number(t.Price || 0) + Number(t.Volume || 0),
          Volume: 0,
        }));
      }
    }
  }
  return [];
}

function calculatePeriod(row) {
  const estimateSell = parseFloat(row.EstimateSell) || 0;
  const Pending3 = parseFloat(row.Pending3) || 0;
  const Pending1 = parseFloat(row.Pending1) || 0;
  const Pending2 = parseFloat(row.Pending2) || 0;
  const squeezeoil = parseFloat(row.Squeeze) || 0;
  const volume = parseFloat(row.Volume) || 0;

  if (estimateSell === 0) {
    return (volume + Pending3 + Pending1 + Pending2 - squeezeoil).toFixed(2);
  }
  return ((volume + Pending3 + Pending1 + Pending2 - squeezeoil) / estimateSell).toFixed(2);
}

function calculateTotalVolume(row) {
  const downHole = parseFloat(row.DownHole) || 0;
  const estimateSell = parseFloat(row.EstimateSell) || 0;
  return (downHole - estimateSell).toFixed(2);
}

function safeCall(fn, arg, name) {
  try {
    return fn(arg);
  } catch (e) {
    console.error(`Error in ${name}:`, e, 'arg:', arg);
    return 0;
  }
}

const CUSTOM_ORDER = ['G95', 'B95', 'B7', 'B7(1)', 'B7(2)', 'G91', 'E20', 'PWD'];
const DEFAULT_TRUCK = [{ id: 0, Truck: '', Price: '', Volume: '' }];

// Direct port of getStationReportsArray(stocks, gasStationOil, selectedDate,
// Squeeze) from GasStationsDetail.js.
export function getStationReportsArray(stocks, gasStationOil, selectedDate, Squeeze = 800) {
  if (!Array.isArray(gasStationOil) || !gasStationOil.length) return [];

  const selected = selectedDate;

  const lastDateMap = new Map();
  gasStationOil.forEach((st) => {
    lastDateMap.set(st.id, getLastReportDate(st.Report));
  });

  const firstStationOfStock = new Set();

  return gasStationOil.map((station) => {
    const stockId = station?.Stock;
    const stock = stocks.find((s) => s.uuid === stockId);

    const isFirst = !firstStationOfStock.has(stockId);
    if (isFirst) firstStationOfStock.add(stockId);

    const lastDate = lastDateMap.get(station.id);

    const squeezeRefDate =
      lastDate && isAfter(selected, lastDate) ? lastDate : subtractDay(selected, 1);

    const volumeRefDate = subtractDay(selected, 1);

    const reportForVolume = station?.Report?.[volumeRefDate.y]?.[volumeRefDate.m]?.[volumeRefDate.d];
    const reportForRef = station?.Report?.[squeezeRefDate.y]?.[squeezeRefDate.m]?.[squeezeRefDate.d];
    const reportForDate = station?.Report?.[selected.y]?.[selected.m]?.[selected.d];

    if (reportForDate) {
      if (reportForVolume && Array.isArray(reportForDate.Products)) {
        reportForDate.Products = reportForDate.Products.map((todayItem) => {
          const yesterdayItem = reportForVolume.Products?.find(
            (p) => p.ProductName === todayItem.ProductName
          );

          const parseNum = (val) => Number(String(val || 0).replace(/,/g, '').trim()) || 0;

          if (yesterdayItem) {
            const prevVol = parseNum(yesterdayItem.Volume + yesterdayItem.Pending3);
            const todayVol = parseNum(todayItem.Volume);
            const todayYsd = parseNum(todayItem.YesterDay);

            let newYesterDay = todayYsd;
            let newSell = parseNum(todayItem.Sell);

            if (todayYsd !== prevVol) {
              newYesterDay = prevVol;
              newSell = prevVol - todayVol;
            }

            return { ...todayItem, YesterDay: newYesterDay, Sell: newSell };
          }
          return todayItem;
        });
      }

      reportForDate.Products = reportForDate.Products.map((prod) => {
        const base = station?.Products?.find((p) => p.Name === prod.ProductName);
        return { ...prod, Backyard: base?.Backyard ?? false };
      });

      return reportForDate;
    }

    let fallbackProducts = [];
    if (Array.isArray(station?.Products) && station.Products.length) fallbackProducts = station.Products;
    else if (Array.isArray(stock?.Products) && stock.Products.length) fallbackProducts = stock.Products;
    else if (station?.Products && typeof station.Products === 'object')
      fallbackProducts = Object.values(station.Products);
    else if (stock?.Products && typeof stock.Products === 'object')
      fallbackProducts = Object.values(stock.Products);

    if (!Array.isArray(fallbackProducts)) fallbackProducts = Array.from(fallbackProducts || []);

    if (!fallbackProducts.length) {
      return {
        Date: formatDateThai(selected),
        Products: [],
        Driver1: '',
        Driver2: '',
        stationId: station.id,
      };
    }

    const defaultProducts = fallbackProducts
      .map((p) => {
        let volYesterday = 0;
        if (reportForVolume?.Products) {
          const v = reportForVolume.Products.find((item) => item.ProductName === p?.Name);
          volYesterday = Number(v?.Volume ?? 0) + Number(v?.Pending3 ?? 0);
        }

        let prevSqueeze = 0;
        let prevEstimateSell = 0;
        if (reportForRef?.Products) {
          const r = reportForRef.Products.find((item) => item.ProductName === p?.Name);
          prevSqueeze = Number(r?.Squeeze ?? 0);
          prevEstimateSell = Number(r?.EstimateSell ?? 0);
        }

        const row = {
          ProductName: (p?.Name ?? '').toString(),
          Capacity: Number(p?.Capacity) || 0,
          Color: p?.Color ?? '',
          FullVolume: Number(p?.FullVolume) || 0,
          Volume: Number(p?.Volume) || 0,

          Squeeze: isFirst ? prevSqueeze || Squeeze || 0 : 0,
          EstimateSell: prevEstimateSell || 0,

          Delivered: Number(p?.Delivered) || 0,
          Pending1: Number(p?.Pending1) || 0,
          Pending2: Number(p?.Pending2) || 0,
          Pending3: Number(p?.Pending3) || 0,
          Period: 0,
          DownHole: Number(p?.DownHole) || 0,

          Backyard: p?.Backyard ?? false,

          YesterDay: volYesterday,
          Sell: volYesterday - Number(p?.Volume),
          TotalVolume: 0,
          OilBalance: 0,
          Difference: 0,
        };

        const Period = safeCall(calculatePeriod, row, 'calculatePeriod');
        const TotalVolume = safeCall(calculateTotalVolume, row, 'calculateTotalVolume');

        return {
          ...row,
          Period,
          TotalVolume,
          PeriodDisplay: Period || row.Volume - row.Squeeze,
          DownHoleDisplay: row.Capacity - Math.round(row.DownHole || 0),
        };
      })
      .sort((a, b) => {
        const ai = CUSTOM_ORDER.indexOf(a.ProductName);
        const bi = CUSTOM_ORDER.indexOf(b.ProductName);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

    return {
      Date: formatDateThai(selected),
      Products: defaultProducts,
      Driver1: '',
      Driver2: '',
      stockID: stock?.id,
      stockName: stock?.Name,
      stationId: station.id,
    };
  });
}

// Direct port of prepareData() from GasStationsDetail.js.
export function prepareData(data) {
  return data.map((st) => ({
    ...st,
    Products: st.Products || [],
    Truck:
      st.Truck && st.Truck.length > 0
        ? st.Truck.map((t) => ({ id: t.id ?? 0, Truck: t.Truck ?? '', Price: t.Price ?? '', Volume: t.Volume ?? '' }))
        : DEFAULT_TRUCK,
    originalProducts: structuredClone(st.Products || []),
    originalTruck: structuredClone(
      st.Truck && st.Truck.length > 0
        ? st.Truck.map((t) => ({ id: t.id ?? 0, Truck: t.Truck ?? '', Price: t.Price ?? '', Volume: t.Volume ?? '' }))
        : DEFAULT_TRUCK
    ),
    hasChanged: false,
  }));
}

// Direct port of the Truck-merging block (the "const merged = prepared.map(...)"
// section) from GasStationsDetail.js's main useEffect.
export function buildMerged(prepared, gasStationOil, selectedDate) {
  const { y, m, d } = selectedDate;

  return prepared.map((station, index) => {
    const st = gasStationOil[index];
    const reportToday = st?.Report?.[y]?.[m]?.[d];
    const todayTruck = reportToday?.Truck ?? [];

    let finalTruck = [];

    if (hasValidTruck(todayTruck)) {
      const yesterdayTruck = findYesterdayTruck(st?.Report, selectedDate);

      finalTruck = todayTruck.map((t, idx) => {
        const yesterdayTotal = getYesterdayTotal(t, yesterdayTruck);

        return {
          id: idx,
          Truck: t.Truck ?? '',
          Price: isEmptyValue(t.Price) ? yesterdayTotal : Number(t.Price),
          Volume: Number(t.Volume) || 0,
        };
      });
    } else {
      const latestTruck = findLatestValidTruck(st?.Report, selectedDate);

      finalTruck =
        latestTruck.length > 0
          ? latestTruck
          : DEFAULT_TRUCK.map((t, idx) => ({ ...t, id: idx, Price: 0, Volume: 0 }));
    }

    const cleanProducts = structuredClone(station.Products ?? []);
    const cleanTruck = structuredClone(finalTruck);

    return {
      ...station,
      Products: cleanProducts,
      originalProducts: structuredClone(cleanProducts),
      Truck: cleanTruck,
      originalTruck: structuredClone(cleanTruck),
      hasChanged: false,
    };
  });
}
