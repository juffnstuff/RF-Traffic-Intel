/**
 * fetch-crux.js
 *
 * Pulls the Chrome User Experience Report (CrUX) public data for the
 * configured origin. CrUX p75 LCP / INP / CLS are direct Google ranking
 * factors and a leading indicator of organic traffic decay — if site
 * speed degrades, GSC clicks/impressions follow within weeks.
 *
 * Three reports per run:
 *   1. Origin-level history (last ~25 collection periods, one row per period
 *      per form factor — phone, desktop, tablet, plus an aggregate ALL row).
 *   2. Origin-level *current* by form factor (single most-recent reading,
 *      used so the dashboard tile can show desktop and mobile separately
 *      without a join across the history table).
 *   3. Per-page CrUX for the top landing pages (read from
 *      ga4_daily_by_landing_page when available). Mobile and desktop
 *      separately. Pages without enough Chrome traffic to qualify return
 *      404 from the API; we silently skip those.
 *
 * Env:
 *   CRUX_API_KEY    — Google Cloud API key with the CrUX API enabled
 *                     https://developer.chrome.com/docs/crux/api
 *   CRUX_ORIGIN     — origin URL like "https://www.rubberform.com" (preferred).
 *                     Required if GSC_SITE_URL is a Domain property
 *                     (sc-domain:...) since CrUX needs an actual origin.
 *   GSC_SITE_URL    — fallback CrUX origin if CRUX_ORIGIN isn't set AND
 *                     GSC_SITE_URL is in URL-prefix form (https://...).
 *   CRUX_TOP_PAGES_N — optional, max number of top landing pages to query
 *                     per form factor. Default 25, capped at 50 to stay
 *                     under the 150 QPM CrUX rate limit comfortably.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'crux.json');
const HISTORY_URL = 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord';
const RECORD_URL  = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

const FORM_FACTORS = ['PHONE', 'DESKTOP', 'TABLET'];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function periodToIso(p) {
  const d = p?.lastDate;
  if (!d) return null;
  const y = String(d.year).padStart(4, '0');
  const m = String(d.month).padStart(2, '0');
  const day = String(d.day).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// CrUX wants an origin URL like https://www.example.com (no trailing slash,
// no path). Resolve from CRUX_ORIGIN first; fall back to GSC_SITE_URL only
// when it's a URL-prefix property (sc-domain:... won't work — Domain
// properties cover every subdomain so we can't pick one automatically).
function resolveOrigin() {
  const explicit = process.env.CRUX_ORIGIN?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const gsc = process.env.GSC_SITE_URL?.trim();
  if (!gsc) return null;
  if (gsc.startsWith('sc-domain:')) {
    throw new Error(
      'GSC_SITE_URL is a Domain property (sc-domain:...) which CrUX cannot accept. '
      + 'Set CRUX_ORIGIN to the specific origin you want CrUX to read '
      + '(e.g. CRUX_ORIGIN=https://www.rubberform.com).'
    );
  }
  return gsc.replace(/\/$/, '');
}

const METRICS = [
  'largest_contentful_paint',
  'interaction_to_next_paint',
  'cumulative_layout_shift',
];

async function postCrux(url, apiKey, body, label) {
  const resp = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.status === 404) {
    // Insufficient traffic for this URL/form-factor — CrUX's normal way of
    // saying "no data". Silent skip is the right behavior; the page just
    // won't appear in the per-page table.
    return { ok: false, status: 404, data: null };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, status: resp.status, error: `CrUX ${label} ${resp.status}: ${text.slice(0, 200)}` };
  }
  const data = await resp.json();
  return { ok: true, data };
}

// Pull the history series (25 collection periods) for either ALL form
// factors or a specific one. Returns rows shaped { date, lcp_p75, inp_p75,
// cls_p75 }; caller adds the form_factor.
async function fetchHistory(apiKey, origin, formFactor /* 'PHONE' | 'DESKTOP' | 'TABLET' | null */, label) {
  const body = { origin, metrics: METRICS };
  if (formFactor) body.formFactor = formFactor;
  const r = await postCrux(HISTORY_URL, apiKey, body, label);
  if (!r.ok) {
    if (r.status === 404) return [];
    console.warn(`⚠  ${r.error}`);
    return [];
  }
  const periods = r.data.record?.collectionPeriods ?? [];
  const m = r.data.record?.metrics ?? {};
  const lcp = m.largest_contentful_paint?.percentilesTimeseries?.p75s ?? [];
  const inp = m.interaction_to_next_paint?.percentilesTimeseries?.p75s ?? [];
  const cls = m.cumulative_layout_shift?.percentilesTimeseries?.p75s ?? [];
  return periods.map((p, i) => ({
    date: periodToIso(p),
    lcp_p75: num(lcp[i]),
    inp_p75: num(inp[i]),
    cls_p75: num(cls[i]),
  })).filter(r => r.date);
}

// Pull the current snapshot for a specific URL + form factor. Returns
// { lcp_p75, inp_p75, cls_p75 } or null if CrUX has no data.
async function fetchCurrentForUrl(apiKey, fullUrl, formFactor, label) {
  const body = { url: fullUrl, formFactor, metrics: METRICS };
  const r = await postCrux(RECORD_URL, apiKey, body, label);
  if (!r.ok) {
    if (r.status === 404) return null;
    console.warn(`⚠  ${r.error}`);
    return null;
  }
  const m = r.data.record?.metrics ?? {};
  // queryRecord returns p75s in metrics.X.percentiles.p75 (singular, current)
  // — different shape from queryHistoryRecord's percentilesTimeseries.
  return {
    lcp_p75: num(m.largest_contentful_paint?.percentiles?.p75),
    inp_p75: num(m.interaction_to_next_paint?.percentiles?.p75),
    cls_p75: num(m.cumulative_layout_shift?.percentiles?.p75),
  };
}

// Read top landing pages from the GA4 dim table — only the paths with
// real session volume, since CrUX won't have data for niche pages anyway.
async function getTopLandingPages({ limit }) {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { getPool } = await import('../db.js');
    const pool = getPool();
    // Last 60 days, top by sessions, exclude empty/zero values.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutStr = cutoff.toISOString().slice(0, 10);
    const { rows } = await pool.query(`
      SELECT landing_page,
             SUM(sessions)::int as sessions
      FROM ga4_daily_by_landing_page
      WHERE date >= $1
        AND landing_page IS NOT NULL
        AND landing_page <> ''
        AND landing_page <> '(not set)'
      GROUP BY landing_page
      HAVING SUM(sessions) > 0
      ORDER BY sessions DESC
      LIMIT $2
    `, [cutStr, limit]);
    return rows.map(r => r.landing_page);
  } catch (e) {
    // Table doesn't exist yet (first deploy after schema migration) or
    // GA4 dim hasn't been backfilled. Either way, skip per-page silently.
    if (/relation .* does not exist/.test(e.message)) return [];
    console.warn(`⚠  Could not read top landing pages: ${e.message}`);
    return [];
  }
}

export async function fetchCrux() {
  const apiKey = process.env.CRUX_API_KEY?.trim();
  if (!apiKey) throw new Error('Missing CRUX_API_KEY env var');
  const origin = resolveOrigin();
  if (!origin) throw new Error('Missing CRUX_ORIGIN (or GSC_SITE_URL in URL-prefix form)');

  console.log(`🔎  CrUX fetch — ${origin}`);

  // ── 1. Origin history — both blended ALL and per-form-factor ──────
  console.log('  → origin history (ALL form factors blended)...');
  const blended = await fetchHistory(apiKey, origin, null, 'origin-all');
  console.log(`    ${blended.length} periods`);

  const byFormFactor = {}; // 'PHONE' | 'DESKTOP' | 'TABLET' -> [rows]
  for (const ff of FORM_FACTORS) {
    console.log(`  → origin history (${ff})...`);
    byFormFactor[ff] = await fetchHistory(apiKey, origin, ff, `origin-${ff}`);
    console.log(`    ${byFormFactor[ff].length} periods`);
  }

  // Flatten history rows into one cross-form-factor array. form_factor='ALL'
  // for the blended series, and the specific value for the form-factor reads.
  const historyRows = [
    ...blended.map(r => ({ ...r, form_factor: 'ALL' })),
    ...FORM_FACTORS.flatMap(ff => byFormFactor[ff].map(r => ({ ...r, form_factor: ff }))),
  ];

  // ── 2. Per-page current snapshot for top landing pages ─────────────
  const limit = Math.min(50, Math.max(0, parseInt(process.env.CRUX_TOP_PAGES_N, 10) || 25));
  const paths = await getTopLandingPages({ limit });
  console.log(`  → per-page CrUX (${paths.length} top landing pages × phone+desktop)...`);

  const today = todayIso();
  const pageRows = [];
  // CrUX is rate-limited at 150 QPM; we do paths * 2 = up to 100 calls per
  // run. Sequential is safe and well under the limit.
  for (const p of paths) {
    // GA4 returns landing_page as the path-with-querystring (e.g. "/products/o-rings");
    // CrUX needs the full URL. Strip a leading "/" once before joining to avoid
    // origin//path.
    const pathOnly = p.startsWith('/') ? p : `/${p}`;
    const fullUrl = `${origin}${pathOnly}`;
    for (const ff of ['PHONE', 'DESKTOP']) {
      const v = await fetchCurrentForUrl(apiKey, fullUrl, ff, `page-${ff}`);
      if (!v) continue;
      pageRows.push({
        date: today,
        page: pathOnly,
        form_factor: ff,
        ...v,
      });
    }
  }
  console.log(`    ${pageRows.length} per-page rows (skipped pages with insufficient CrUX coverage)`);

  // ── 3. Persist ────────────────────────────────────────────────────
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'crux',
    origin,
    history: historyRows,
    pages: pageRows,
  }, null, 2));

  if (process.env.DATABASE_URL) {
    const { upsertCruxDaily, upsertCruxDailyByPage } = await import('../db.js');
    const histInserted = await upsertCruxDaily(historyRows);
    const pageInserted = await upsertCruxDailyByPage(pageRows);
    console.log(`✅  Upserted ${histInserted} origin rows + ${pageInserted} per-page rows into PostgreSQL`);
    return { daily: histInserted, pages: pageInserted };
  }
  return { daily: historyRows.length, pages: pageRows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchCrux().catch(e => {
    console.error('❌  CrUX fetch failed:', e.message);
    process.exit(1);
  });
}
