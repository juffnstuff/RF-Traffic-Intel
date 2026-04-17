/**
 * Analytics utilities for the RF Traffic Intelligence dashboard.
 * Provides moving averages, normalization, and lead-lag correlation.
 */

/**
 * Compute a trailing moving average for a numeric array.
 * Uses a partial window at the start of the series (mean of 0..i) so that
 * the MA has a value from day 1 rather than blank for the first `window-1` days.
 * Once enough history exists, it becomes a full trailing `window` average.
 * @param {number[]} values - raw data points
 * @param {number} window - max number of periods
 * @returns {(number|null)[]} MA values
 */
export function movingAverage(values, window) {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    if (slice.length === 0) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/**
 * Min-max normalize an array to [0, 100].
 */
export function normalize(values) {
  const nums = values.filter(v => v != null);
  if (nums.length === 0) return values;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max === min) return values.map(v => (v != null ? 50 : null));
  return values.map(v => (v != null ? ((v - min) / (max - min)) * 100 : null));
}

/**
 * Pearson correlation coefficient between two arrays (ignoring nulls).
 */
export function pearson(xs, ys) {
  const pairs = xs
    .map((x, i) => [x, ys[i]])
    .filter(([x, y]) => x != null && y != null);
  const n = pairs.length;
  if (n < 5) return 0;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (const [x, y] of pairs) {
    const dx = x - mx;
    const dy = y - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

/**
 * Find the lag (0..maxLag) that maximises |pearson(leading, lagged)|.
 * Returns { bestLag, bestR, correlations[] }.
 */
export function leadLag(leading, lagging, maxLag = 45) {
  const correlations = [];
  let bestLag = 0;
  let bestR = 0;

  for (let lag = 0; lag <= maxLag; lag++) {
    const shifted = lagging.slice(lag);
    const trimmed = leading.slice(0, shifted.length);
    const r = pearson(trimmed, shifted);
    correlations.push(r);
    if (Math.abs(r) > Math.abs(bestR)) {
      bestR = r;
      bestLag = lag;
    }
  }

  return { bestLag, bestR, correlations };
}

/**
 * Filter daily rows to weekdays only.
 */
export function weekdaysOnly(daily) {
  return daily.filter(d => {
    const day = new Date(d.date).getDay();
    return day !== 0 && day !== 6;
  });
}
