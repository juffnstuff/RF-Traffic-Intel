/**
 * fetch-ga4.js
 *
 * Pulls daily web-traffic metrics from Google Analytics 4 via the Data API,
 * using a service-account credential stored in GOOGLE_CREDENTIALS_JSON.
 *
 * Two reports per run:
 *   - Aggregate daily (whole account)       → ga4_daily
 *   - Daily by sessionCampaignName          → ga4_daily_by_campaign
 *
 * Metrics pulled: sessions, totalUsers, newUsers, engagedSessions,
 *   screenPageViews, averageSessionDuration, bounceRate, conversions,
 *   totalRevenue. Rate fields round-trip as floats; everything else as int.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'ga4-daily.json');

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Parse credentials eagerly so malformed JSON fails at module-load instead of
// mid-fetch. `null` when the env var is unset (server gates GA4 imports on
// hasGA4, so this only surfaces an error for the "env present but malformed" case).
const GA4_CREDENTIALS = (() => {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_CREDENTIALS_JSON is not valid JSON. Paste the full service-account key file contents.');
  }
})();

function buildClient() {
  if (!GA4_CREDENTIALS) throw new Error('Missing env var: GOOGLE_CREDENTIALS_JSON');
  return new BetaAnalyticsDataClient({ credentials: GA4_CREDENTIALS });
}

async function runReportWithRetry(client, request, label) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.runReport(request);
    } catch (e) {
      const status = Number(e.code ?? e.status);
      const retriable = !Number.isFinite(status)
        || status === 429
        || (status >= 500 && status < 600)
        || e.code === 'ETIMEDOUT'
        || e.code === 'ECONNRESET'
        || e.code === 'ENOTFOUND';
      if (!retriable || attempt >= MAX_ATTEMPTS - 1) throw e;
      const waitMs = Math.min(30000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 500));
      console.log(`    ⏳ ${label} failed (${e.message}); retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

function parseGa4Date(s) {
  // GA4 returns YYYYMMDD
  if (!s || s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

const DATE_DIM       = { name: 'date' };
const CAMPAIGN_DIM   = { name: 'sessionCampaignName' };
const CHANNEL_DIM    = { name: 'sessionDefaultChannelGroup' };
const LANDING_DIM    = { name: 'landingPagePlusQueryString' };
const SOURCE_DIM     = { name: 'sessionSource' };
const MEDIUM_DIM     = { name: 'sessionMedium' };
const FIRST_SOURCE_DIM = { name: 'firstUserSource' };
const FIRST_MEDIUM_DIM = { name: 'firstUserMedium' };
const DEVICE_DIM     = { name: 'deviceCategory' };
const COUNTRY_DIM    = { name: 'country' };
const EVENT_DIM      = { name: 'eventName' };
const NEW_RET_DIM    = { name: 'newVsReturning' };

const METRICS_AGG = [
  { name: 'sessions' },
  { name: 'totalUsers' },
  { name: 'newUsers' },
  { name: 'engagedSessions' },
  { name: 'screenPageViews' },
  { name: 'averageSessionDuration' },
  { name: 'bounceRate' },
  { name: 'conversions' },
  { name: 'totalRevenue' },
];

// Campaign reports can't use averageSessionDuration/bounceRate (would require
// per-session grouping not supported at campaign grain in a single request).
// Keep counts only for the per-campaign breakdown.
const METRICS_CAMPAIGN = [
  { name: 'sessions' },
  { name: 'totalUsers' },
  { name: 'newUsers' },
  { name: 'engagedSessions' },
  { name: 'screenPageViews' },
  { name: 'conversions' },
  { name: 'totalRevenue' },
];

// Lighter metric set for breakdowns where only counts + revenue matter.
const METRICS_LIGHT = [
  { name: 'sessions' },
  { name: 'totalUsers' },
  { name: 'newUsers' },
  { name: 'engagedSessions' },
  { name: 'screenPageViews' },
  { name: 'conversions' },
  { name: 'totalRevenue' },
];

// Event-name reports only need eventCount + conversions (we'll surface the
// rows where conversions > 0 as "conversion events"; the rest as a long
// tail of fired events for context).
const METRICS_EVENT = [
  { name: 'eventCount' },
  { name: 'conversions' },
  { name: 'totalRevenue' },
];

/**
 * @param {object} opts
 * @param {string|null} opts.since — ISO date string, or null for full history (2 years back).
 */
export async function fetchGa4({ since = null } = {}) {
  const propertyId = requireEnv('GA4_PROPERTY_ID');
  const client = buildClient();

  // GA4 keeps data for a while, but full history can be long. Default backfill
  // looks back 2 years — plenty to compute 90-DMA and YoY comparisons.
  const endDate = 'today';
  const startDate = since
    ? since
    : (() => {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 2);
        return d.toISOString().slice(0, 10);
      })();

  const mode = since ? `incremental (since ${since})` : `full history (last 2y)`;
  console.log(`🔎  GA4 fetch — ${mode}`);
  console.log(`    Property: ${propertyId}`);

  // ── 1. Aggregate daily ───────────────────────────────────────────────
  console.log('  → aggregate daily metrics...');
  const [aggResp] = await runReportWithRetry(client, {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [DATE_DIM],
    metrics: METRICS_AGG,
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 100000,
  }, 'aggregate');
  const aggRows = (aggResp.rows || []).map(r => {
    const date = parseGa4Date(r.dimensionValues?.[0]?.value);
    const m = r.metricValues || [];
    return {
      date,
      sessions:            num(m[0]?.value),
      total_users:         num(m[1]?.value),
      new_users:           num(m[2]?.value),
      engaged_sessions:    num(m[3]?.value),
      screen_page_views:   num(m[4]?.value),
      avg_session_duration: num(m[5]?.value),
      bounce_rate:         num(m[6]?.value),
      conversions:         num(m[7]?.value),
      total_revenue:       num(m[8]?.value),
    };
  }).filter(r => r.date);
  console.log(`    ${aggRows.length} daily rows`);

  // ── 2. Per-campaign daily ────────────────────────────────────────────
  console.log('  → daily by campaign...');
  const [campResp] = await runReportWithRetry(client, {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [DATE_DIM, CAMPAIGN_DIM],
    metrics: METRICS_CAMPAIGN,
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 250000,
  }, 'campaign');
  const campRows = (campResp.rows || []).map(r => {
    const date = parseGa4Date(r.dimensionValues?.[0]?.value);
    const campaign_name = r.dimensionValues?.[1]?.value ?? '';
    const m = r.metricValues || [];
    return {
      date,
      campaign_name,
      sessions:          num(m[0]?.value),
      total_users:       num(m[1]?.value),
      new_users:         num(m[2]?.value),
      engaged_sessions:  num(m[3]?.value),
      screen_page_views: num(m[4]?.value),
      conversions:       num(m[5]?.value),
      total_revenue:     num(m[6]?.value),
    };
  }).filter(r => r.date);
  console.log(`    ${campRows.length} campaign-day rows`);

  // ── 3. Per-channel daily (organic / paid / direct / referral / etc.) ──
  console.log('  → daily by channel...');
  const [chanResp] = await runReportWithRetry(client, {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [DATE_DIM, CHANNEL_DIM],
    metrics: METRICS_CAMPAIGN,
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 250000,
  }, 'channel');
  const chanRows = (chanResp.rows || []).map(r => {
    const date = parseGa4Date(r.dimensionValues?.[0]?.value);
    const channel = r.dimensionValues?.[1]?.value ?? '';
    const m = r.metricValues || [];
    return {
      date,
      channel,
      sessions:          num(m[0]?.value),
      total_users:       num(m[1]?.value),
      new_users:         num(m[2]?.value),
      engaged_sessions:  num(m[3]?.value),
      screen_page_views: num(m[4]?.value),
      conversions:       num(m[5]?.value),
      total_revenue:     num(m[6]?.value),
    };
  }).filter(r => r.date);
  console.log(`    ${chanRows.length} channel-day rows`);

  // Helper to run a (date, dim) report and shape rows for db.js. Pulls the
  // metric values in METRICS_LIGHT order and tags the dim under `dimKey`.
  const runDimReport = async (dim, dimKey, label, { metrics = METRICS_LIGHT, limit = 250000 } = {}) => {
    console.log(`  → daily by ${label}...`);
    const [resp] = await runReportWithRetry(client, {
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [DATE_DIM, dim],
      metrics,
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit,
    }, label);
    const rows = (resp.rows || []).map(r => {
      const date = parseGa4Date(r.dimensionValues?.[0]?.value);
      const dimValue = r.dimensionValues?.[1]?.value ?? '';
      const m = r.metricValues || [];
      const out = { date, [dimKey]: dimValue };
      if (metrics === METRICS_EVENT) {
        out.event_count   = num(m[0]?.value);
        out.conversions   = num(m[1]?.value);
        out.total_revenue = num(m[2]?.value);
      } else {
        out.sessions          = num(m[0]?.value);
        out.total_users       = num(m[1]?.value);
        out.new_users         = num(m[2]?.value);
        out.engaged_sessions  = num(m[3]?.value);
        out.screen_page_views = num(m[4]?.value);
        out.conversions       = num(m[5]?.value);
        out.total_revenue     = num(m[6]?.value);
      }
      return out;
    }).filter(r => r.date);
    console.log(`    ${rows.length} ${label}-day rows`);
    return rows;
  };

  // ── 4. Per-(landing page) daily ─────────────────────────────────────
  const landingRows = await runDimReport(LANDING_DIM, 'landing_page', 'landing-page');

  // ── 5. Per-(source/medium) daily — combined dim pair so server can
  //      separate by either or aggregate together. Requires both dims
  //      since "google" can be both organic and cpc on the same day.
  console.log('  → daily by source/medium...');
  const [smResp] = await runReportWithRetry(client, {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [DATE_DIM, SOURCE_DIM, MEDIUM_DIM],
    metrics: METRICS_LIGHT,
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 250000,
  }, 'source-medium');
  const sourceMediumRows = (smResp.rows || []).map(r => {
    const date = parseGa4Date(r.dimensionValues?.[0]?.value);
    const source = r.dimensionValues?.[1]?.value ?? '';
    const medium = r.dimensionValues?.[2]?.value ?? '';
    const m = r.metricValues || [];
    return {
      date, source, medium,
      sessions:          num(m[0]?.value),
      total_users:       num(m[1]?.value),
      new_users:         num(m[2]?.value),
      engaged_sessions:  num(m[3]?.value),
      screen_page_views: num(m[4]?.value),
      conversions:       num(m[5]?.value),
      total_revenue:     num(m[6]?.value),
    };
  }).filter(r => r.date);
  console.log(`    ${sourceMediumRows.length} source/medium-day rows`);

  // ── 6. Per-(first-touch source/medium) daily — first-touch attribution
  //      on a 30-90d B2B cycle tells a very different story than
  //      session-source. Direct often hides paid-then-organic chains.
  console.log('  → daily by first-touch source/medium...');
  const [ftResp] = await runReportWithRetry(client, {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [DATE_DIM, FIRST_SOURCE_DIM, FIRST_MEDIUM_DIM],
    metrics: METRICS_LIGHT,
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 250000,
  }, 'first-touch');
  const firstTouchRows = (ftResp.rows || []).map(r => {
    const date = parseGa4Date(r.dimensionValues?.[0]?.value);
    const source = r.dimensionValues?.[1]?.value ?? '';
    const medium = r.dimensionValues?.[2]?.value ?? '';
    const m = r.metricValues || [];
    return {
      date, first_source: source, first_medium: medium,
      sessions:          num(m[0]?.value),
      total_users:       num(m[1]?.value),
      new_users:         num(m[2]?.value),
      engaged_sessions:  num(m[3]?.value),
      screen_page_views: num(m[4]?.value),
      conversions:       num(m[5]?.value),
      total_revenue:     num(m[6]?.value),
    };
  }).filter(r => r.date);
  console.log(`    ${firstTouchRows.length} first-touch-day rows`);

  // ── 7. Per-device daily ─────────────────────────────────────────────
  const deviceRows = await runDimReport(DEVICE_DIM, 'device', 'device', { limit: 50000 });

  // ── 8. Per-country daily ────────────────────────────────────────────
  const countryRows = await runDimReport(COUNTRY_DIM, 'country', 'country', { limit: 100000 });

  // ── 9. Per-event daily — used to surface conversion events (RFQ form,
  //      phone-click, etc.) as their own KPIs. Filtering happens client-
  //      side via conversions > 0 since GA4 doesn't have an "isConversion"
  //      dimension.
  const eventRows = await runDimReport(EVENT_DIM, 'event_name', 'event', { metrics: METRICS_EVENT, limit: 100000 });

  // ── 10. Per-(new-vs-returning) daily — top vs bottom funnel proxy.
  const newRetRows = await runDimReport(NEW_RET_DIM, 'visitor_type', 'new-vs-returning', { limit: 5000 });

  // ── 11. Persist ──────────────────────────────────────────────────────
  // Always write a JSON cache so there's a fallback when DATABASE_URL is unset
  // or the DB is unreachable. Mirrors fetch-netsuite.js's cache behavior.
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'ga4',
    propertyId,
    since,
    aggregate: aggRows,
    byCampaign: campRows,
    byChannel: chanRows,
    byLandingPage: landingRows,
    bySourceMedium: sourceMediumRows,
    byFirstTouch: firstTouchRows,
    byDevice: deviceRows,
    byCountry: countryRows,
    byEvent: eventRows,
    byNewVsReturning: newRetRows,
  }, null, 2));
  console.log(`✅  Wrote GA4 cache: ${aggRows.length} agg + ${campRows.length} campaign + ${chanRows.length} channel + ${landingRows.length} landing + ${sourceMediumRows.length} source/medium + ${firstTouchRows.length} first-touch + ${deviceRows.length} device + ${countryRows.length} country + ${eventRows.length} event + ${newRetRows.length} new-vs-returning rows`);

  if (process.env.DATABASE_URL) {
    const {
      upsertGa4Daily, upsertGa4DailyByCampaign, upsertGa4DailyByChannel,
      upsertGa4DailyByLandingPage, upsertGa4DailyBySourceMedium,
      upsertGa4DailyByFirstTouch, upsertGa4DailyByDevice,
      upsertGa4DailyByCountry, upsertGa4DailyByEvent,
      upsertGa4DailyByNewVsReturning,
    } = await import('../db.js');
    const aggInserted  = await upsertGa4Daily(aggRows, { replaceSince: since });
    const campInserted = await upsertGa4DailyByCampaign(campRows, { replaceSince: since });
    const chanInserted = await upsertGa4DailyByChannel(chanRows, { replaceSince: since });
    const lpInserted   = await upsertGa4DailyByLandingPage(landingRows, { replaceSince: since });
    const smInserted   = await upsertGa4DailyBySourceMedium(sourceMediumRows, { replaceSince: since });
    const ftInserted   = await upsertGa4DailyByFirstTouch(firstTouchRows, { replaceSince: since });
    const dvInserted   = await upsertGa4DailyByDevice(deviceRows, { replaceSince: since });
    const ctInserted   = await upsertGa4DailyByCountry(countryRows, { replaceSince: since });
    const evInserted   = await upsertGa4DailyByEvent(eventRows, { replaceSince: since });
    const nrInserted   = await upsertGa4DailyByNewVsReturning(newRetRows, { replaceSince: since });
    console.log(`✅  Upserted ${aggInserted} agg + ${campInserted} campaign + ${chanInserted} channel + ${lpInserted} landing + ${smInserted} source/medium + ${ftInserted} first-touch + ${dvInserted} device + ${ctInserted} country + ${evInserted} event + ${nrInserted} new-vs-returning rows into PostgreSQL`);
    return {
      aggregate: aggInserted, byCampaign: campInserted, byChannel: chanInserted,
      byLandingPage: lpInserted, bySourceMedium: smInserted, byFirstTouch: ftInserted,
      byDevice: dvInserted, byCountry: ctInserted, byEvent: evInserted,
      byNewVsReturning: nrInserted,
    };
  }
  return {
    aggregate: aggRows.length, byCampaign: campRows.length, byChannel: chanRows.length,
    byLandingPage: landingRows.length, bySourceMedium: sourceMediumRows.length,
    byFirstTouch: firstTouchRows.length, byDevice: deviceRows.length,
    byCountry: countryRows.length, byEvent: eventRows.length,
    byNewVsReturning: newRetRows.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const since = args.includes('--full') ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  })();

  fetchGa4({ since }).catch(e => {
    console.error('❌  GA4 fetch failed:', e.message);
    process.exit(1);
  });
}
