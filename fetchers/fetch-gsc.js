/**
 * fetch-gsc.js
 *
 * Pulls search-performance data from Google Search Console using the SAME
 * service-account credential already used for GA4 (`GOOGLE_CREDENTIALS_JSON`).
 * The service account must be granted read access on the target GSC property
 * — add it as a "User" at https://search.google.com/search-console/users.
 *
 * Three reports per run:
 *   - Per-day aggregate                  →  gsc_daily
 *   - Top 250 queries, last-28d window   →  gsc_top_queries
 *   - Top 250 pages,   last-28d window   →  gsc_top_pages
 *
 * Env:
 *   GSC_SITE_URL              — e.g. "https://www.rubberform.com/" (trailing slash matters)
 *   GOOGLE_CREDENTIALS_JSON   — same service-account key used for GA4
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'gsc.json');

// GSC data is aggregated nightly on Google's side; anything newer than ~2d is
// partial. The lookback cap of 16 months matches Search Console's own UI.
const GSC_MAX_LOOKBACK_MONTHS = 16;
const TOP_WINDOW_DAYS = 28;
const TOP_ROW_LIMIT = 250;

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const GSC_CREDENTIALS = (() => {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_CREDENTIALS_JSON is not valid JSON.');
  }
})();

function buildClient() {
  if (!GSC_CREDENTIALS) throw new Error('Missing env var: GOOGLE_CREDENTIALS_JSON');
  const auth = new google.auth.JWT(
    GSC_CREDENTIALS.client_email,
    null,
    GSC_CREDENTIALS.private_key,
    ['https://www.googleapis.com/auth/webmasters.readonly'],
  );
  return google.webmasters({ version: 'v3', auth });
}

async function queryWithRetry(client, siteUrl, requestBody, label) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await client.searchanalytics.query({
        siteUrl,
        requestBody,
      });
      return data;
    } catch (e) {
      const status = Number(e.code ?? e.status);
      const retriable = !Number.isFinite(status)
        || status === 429
        || (status >= 500 && status < 600)
        || e.code === 'ETIMEDOUT'
        || e.code === 'ECONNRESET';
      if (!retriable || attempt >= MAX_ATTEMPTS - 1) throw e;
      const waitMs = Math.min(30000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 500));
      console.log(`    ⏳ ${label} failed (${e.message}); retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function daysBackIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function fetchGsc({ since = null } = {}) {
  const siteUrl = requireEnv('GSC_SITE_URL');
  const client = buildClient();

  const endDate = new Date().toISOString().slice(0, 10);
  const maxLookbackStart = (() => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - GSC_MAX_LOOKBACK_MONTHS);
    return d.toISOString().slice(0, 10);
  })();
  const startDate = since
    ? (since < maxLookbackStart ? maxLookbackStart : since)
    : maxLookbackStart;

  const mode = since ? `incremental (since ${startDate})` : `full history (${GSC_MAX_LOOKBACK_MONTHS}mo)`;
  console.log(`🔎  GSC fetch — ${mode}`);
  console.log(`    Site: ${siteUrl}`);

  // ── 1. Per-day aggregate ────────────────────────────────────────────
  console.log('  → daily aggregate...');
  const dailyData = await queryWithRetry(client, siteUrl, {
    startDate, endDate,
    dimensions: ['date'],
    rowLimit: 25000,
  }, 'gsc-daily');
  const dailyRows = (dailyData.rows || []).map(r => ({
    date:        r.keys[0],
    clicks:      num(r.clicks),
    impressions: num(r.impressions),
    ctr:         num(r.ctr),
    position:    num(r.position),
  }));
  console.log(`    ${dailyRows.length} daily rows`);

  // ── 2. Top queries (trailing window) ────────────────────────────────
  console.log('  → top queries...');
  const queryWindowStart = daysBackIso(TOP_WINDOW_DAYS);
  const queryData = await queryWithRetry(client, siteUrl, {
    startDate: queryWindowStart,
    endDate,
    dimensions: ['query'],
    rowLimit: TOP_ROW_LIMIT,
  }, 'gsc-queries');
  const queryRows = (queryData.rows || []).map(r => ({
    window_end_date: endDate,
    query:           r.keys[0],
    clicks:          num(r.clicks),
    impressions:     num(r.impressions),
    ctr:             num(r.ctr),
    position:        num(r.position),
  }));
  console.log(`    ${queryRows.length} top queries`);

  // ── 3. Top pages (trailing window) ──────────────────────────────────
  console.log('  → top pages...');
  const pageData = await queryWithRetry(client, siteUrl, {
    startDate: queryWindowStart,
    endDate,
    dimensions: ['page'],
    rowLimit: TOP_ROW_LIMIT,
  }, 'gsc-pages');
  const pageRows = (pageData.rows || []).map(r => ({
    window_end_date: endDate,
    page:            r.keys[0],
    clicks:          num(r.clicks),
    impressions:     num(r.impressions),
    ctr:             num(r.ctr),
    position:        num(r.position),
  }));
  console.log(`    ${pageRows.length} top pages`);

  // ── 4. Persist ──────────────────────────────────────────────────────
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'gsc',
    siteUrl,
    since,
    daily: dailyRows,
    topQueries: queryRows,
    topPages: pageRows,
  }, null, 2));
  console.log(`✅  Wrote GSC cache: ${dailyRows.length} daily + ${queryRows.length} queries + ${pageRows.length} pages`);

  if (process.env.DATABASE_URL) {
    const { upsertGscDaily, upsertGscTopQueries, upsertGscTopPages } = await import('../db.js');
    const dailyInserted   = await upsertGscDaily(dailyRows, { replaceSince: since });
    const queriesInserted = await upsertGscTopQueries(queryRows);
    const pagesInserted   = await upsertGscTopPages(pageRows);
    console.log(`✅  Upserted ${dailyInserted} daily + ${queriesInserted} queries + ${pagesInserted} pages into PostgreSQL`);
    return { daily: dailyInserted, topQueries: queriesInserted, topPages: pagesInserted };
  }
  return { daily: dailyRows.length, topQueries: queryRows.length, topPages: pageRows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const since = args.includes('--full') ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  })();

  fetchGsc({ since }).catch(e => {
    console.error('❌  GSC fetch failed:', e.message);
    process.exit(1);
  });
}
