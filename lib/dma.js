/**
 * Server-side moving-average + lead-lag helpers.
 *
 * The dashboard already ships frontend versions in
 * dashboard/src/utils/analytics.js — these are the same algorithms
 * implemented for Node so the /api/traction/scorecard-summary
 * endpoint can return pre-computed DMA values to RF Traction's
 * scorecard without making it re-derive the math client-side.
 */

/**
 * Trailing moving average over the last `window` values.
 * Uses a partial window for indices < window-1 so the series has
 * a value from day 1 — same behavior as the frontend helper, so
 * the two endpoints (live dashboard, traction summary) stay in
 * lockstep on edge-day numbers.
 */
export function movingAverage(values, window) {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    if (slice.length === 0) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

function pearson(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] != null && ys[i] != null) pairs.push([xs[i], ys[i]]);
  }
  const n = pairs.length;
  if (n < 5) return 0;
  let mx = 0, my = 0;
  for (const [x, y] of pairs) { mx += x; my += y; }
  mx /= n; my /= n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (const [x, y] of pairs) {
    const dx = x - mx;
    const dy = y - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? 0 : num / den;
}

/**
 * Detrended lead-lag scan. Returns the lag (0..maxLag days) where
 * Pearson r between (leading30 − leading90) and (lagging30 − lagging90)
 * peaks in magnitude. Detrending removes long-period co-movement so
 * the result reflects real short-term lead-lag, not trend alignment.
 */
export function bestLagDetrended(leading30, leading90, lagging30, lagging90, maxLag = 45) {
  const detrend = (s, l) => s.map((v, i) => (v == null || l[i] == null) ? null : v - l[i]);
  const lead = detrend(leading30, leading90);
  const lag  = detrend(lagging30, lagging90);

  let bestLag = 0;
  let bestR   = 0;
  for (let k = 0; k <= maxLag; k++) {
    const shifted = lag.slice(k);
    const trimmed = lead.slice(0, shifted.length);
    const r = pearson(trimmed, shifted);
    if (Math.abs(r) > Math.abs(bestR)) {
      bestR   = r;
      bestLag = k;
    }
  }
  return { bestLag, bestR };
}

/**
 * Zero-fill a calendar gap so the MA window matches real days.
 *
 * Mirrors db.zerofillDaily but accepts arbitrary value-bearing keys
 * — used here when the daily and ga4 series need to be aligned on
 * the same calendar without their respective zerofills disagreeing
 * on which days exist.
 */
export function alignByDate(rows, keys, startIso, endIso) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out = [];
  const cur = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso   + 'T00:00:00Z');
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10);
    const r = byDate.get(iso);
    const row = { date: iso };
    for (const k of keys) row[k] = r ? Number(r[k] ?? 0) : 0;
    out.push(row);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * ISO Monday for a YYYY-MM-DD date. Same calendar convention used by
 * the RF-DSOATD endpoint so weekly_trend buckets line up across the
 * two payloads on the same week_start key.
 */
export function isoWeekMonday(dateIso) {
  const d = new Date(dateIso + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

export function addDays(dateIso, days) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
