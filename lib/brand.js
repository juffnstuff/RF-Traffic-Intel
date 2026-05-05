/**
 * Branded vs non-branded query classifier.
 *
 * Branded queries are demand capture (somebody already knows you and
 * searched for you by name); non-branded queries are demand creation
 * (a generic search you happened to rank for). For B2B SEO this is the
 * single most important split — the lag from branded vs non-branded
 * organic to a quote is wildly different, and the strategic implication
 * (do more SEO content vs. defend brand-term ad spend) hinges on which
 * pile is growing.
 *
 * The default regex matches "rubberform" and common spacing/hyphen
 * variants. Override with the BRAND_QUERY_REGEX env var to add legacy
 * product names, common misspellings, or competitor traps. Examples:
 *
 *   BRAND_QUERY_REGEX="rubberform|rf-traffic|rubberform's"
 *   BRAND_QUERY_REGEX="rubberform|company-x|legacy-product"
 */

const DEFAULT_BRAND = /rubberform|rubber[-\s]?form/i;

export function getBrandRegex() {
  const raw = process.env.BRAND_QUERY_REGEX?.trim();
  if (!raw) return DEFAULT_BRAND;
  try {
    return new RegExp(raw, 'i');
  } catch (e) {
    console.warn(`⚠  Invalid BRAND_QUERY_REGEX (${e.message}); falling back to default`);
    return DEFAULT_BRAND;
  }
}

export function isBranded(query, regex = getBrandRegex()) {
  return !!(query && regex.test(query));
}

export function classifyQueries(rows, regex = getBrandRegex()) {
  const branded = [];
  const nonBranded = [];
  for (const r of rows) {
    (isBranded(r.query ?? r.dimension, regex) ? branded : nonBranded).push(r);
  }
  return { branded, nonBranded };
}

/**
 * Aggregate clicks/impressions/(weighted) CTR/(weighted) position
 * for a list of GSC top-query rows.
 */
export function summarizeQueries(rows) {
  let clicks = 0, impressions = 0, posWeighted = 0;
  for (const r of rows) {
    const c = Number(r.clicks) || 0;
    const i = Number(r.impressions) || 0;
    clicks += c;
    impressions += i;
    posWeighted += (Number(r.position) || 0) * i;
  }
  return {
    queries: rows.length,
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    avg_position: impressions > 0 ? posWeighted / impressions : null,
  };
}
