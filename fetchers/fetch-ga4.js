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
import { BetaAnalyticsDataClient } from '@google-analytics/data';

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function buildClient() {
  const raw = requireEnv('GOOGLE_CREDENTIALS_JSON');
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new Error('GOOGLE_CREDENTIALS_JSON is not valid JSON. Paste the full service-account key file contents.');
  }
  return new BetaAnalyticsDataClient({ credentials });
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
  const [aggResp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [DATE_DIM],
    metrics: METRICS_AGG,
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 100000,
  });
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
  const [campResp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [DATE_DIM, CAMPAIGN_DIM],
    metrics: METRICS_CAMPAIGN,
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 250000,
  });
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
  const [chanResp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [DATE_DIM, CHANNEL_DIM],
    metrics: METRICS_CAMPAIGN,
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 250000,
  });
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

  // ── 4. Persist ───────────────────────────────────────────────────────
  if (process.env.DATABASE_URL) {
    const { upsertGa4Daily, upsertGa4DailyByCampaign, upsertGa4DailyByChannel } = await import('../db.js');
    const aggInserted  = await upsertGa4Daily(aggRows, { replaceSince: since });
    const campInserted = await upsertGa4DailyByCampaign(campRows, { replaceSince: since });
    const chanInserted = await upsertGa4DailyByChannel(chanRows, { replaceSince: since });
    console.log(`✅  Upserted ${aggInserted} aggregate + ${campInserted} campaign + ${chanInserted} channel rows into PostgreSQL`);
    return { aggregate: aggInserted, byCampaign: campInserted, byChannel: chanInserted };
  } else {
    console.log('⚠️  DATABASE_URL not set — GA4 data not persisted');
    return { aggregate: aggRows.length, byCampaign: campRows.length, byChannel: chanRows.length };
  }
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
