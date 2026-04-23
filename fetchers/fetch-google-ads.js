/**
 * fetch-google-ads.js
 *
 * Pulls per-campaign daily metrics from the Google Ads REST API using an
 * OAuth refresh token. Kept as a raw `fetch` call (no SDK dep) so this file
 * stays small and predictable.
 *
 * One report per run:
 *   - Per-campaign daily  →  google_ads_daily_by_campaign
 *
 * Env required (all must be set or the fetcher no-ops):
 *   GOOGLE_ADS_DEVELOPER_TOKEN     — from ads.google.com/aw/apicenter (MCC)
 *   GOOGLE_ADS_CLIENT_ID           — OAuth client (Desktop app type)
 *   GOOGLE_ADS_CLIENT_SECRET
 *   GOOGLE_ADS_REFRESH_TOKEN       — produced by a one-shot consent flow
 *   GOOGLE_ADS_CUSTOMER_ID         — 10-digit account id, NO dashes
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID   — optional, MCC id when customer is under one
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'google-ads-daily.json');

const ADS_API_VERSION = 'v17';

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function fetchWithRetry(url, init, label) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS - 1) throw e;
      const waitMs = Math.min(30000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 500));
      console.log(`    ⏳ ${label} network error (${e.message}); retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (res.ok) return res;
    const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retriable || attempt >= MAX_ATTEMPTS - 1) {
      const body = await res.text().catch(() => '');
      throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    const waitMs = Math.min(30000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 500));
    console.log(`    ⏳ ${label} HTTP ${res.status}; retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${MAX_ATTEMPTS})`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id:     requireEnv('GOOGLE_ADS_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_ADS_CLIENT_SECRET'),
    refresh_token: requireEnv('GOOGLE_ADS_REFRESH_TOKEN'),
    grant_type:    'refresh_token',
  });
  const res = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, 'token-exchange');
  const j = await res.json();
  if (!j.access_token) throw new Error(`OAuth token exchange returned no access_token: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export async function fetchGoogleAds({ since = null } = {}) {
  const customerId    = requireEnv('GOOGLE_ADS_CUSTOMER_ID').replace(/-/g, '');
  const developerToken = requireEnv('GOOGLE_ADS_DEVELOPER_TOKEN');
  const loginCustomer = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '') || null;

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = since || (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 2);
    return d.toISOString().slice(0, 10);
  })();

  const mode = since ? `incremental (since ${since})` : `full history (last 2y)`;
  console.log(`🔎  Google Ads fetch — ${mode}`);
  console.log(`    Customer: ${customerId}${loginCustomer ? ` (via MCC ${loginCustomer})` : ''}`);

  const accessToken = await getAccessToken();

  // Google Ads REST uses searchStream for large result sets — one POST,
  // response is an array of objects each with a `results` array. Smaller
  // footprint than SDK pagination and plenty for a campaign×day query.
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      campaign.status,
      segments.date,
      metrics.cost_micros,
      metrics.clicks,
      metrics.impressions,
      metrics.conversions,
      metrics.conversions_value,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
    ORDER BY segments.date
  `;

  const headers = {
    'Authorization':   `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type':    'application/json',
  };
  if (loginCustomer) headers['login-customer-id'] = loginCustomer;

  console.log('  → per-campaign daily metrics...');
  const url = `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  }, 'googleAds:searchStream');

  const chunks = await res.json();
  const rows = [];
  for (const chunk of chunks) {
    for (const row of (chunk.results || [])) {
      const date = row.segments?.date;
      if (!date) continue;
      rows.push({
        date,
        campaign_id:      String(row.campaign?.id ?? ''),
        campaign_name:    row.campaign?.name ?? '',
        channel_type:     row.campaign?.advertisingChannelType ?? '',
        status:           row.campaign?.status ?? '',
        cost:             num(row.metrics?.costMicros) / 1_000_000,
        clicks:           num(row.metrics?.clicks),
        impressions:      num(row.metrics?.impressions),
        conversions:      num(row.metrics?.conversions),
        conversion_value: num(row.metrics?.conversionsValue),
        avg_cpc:          num(row.metrics?.averageCpc) / 1_000_000,
      });
    }
  }
  console.log(`    ${rows.length} campaign-day rows`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'google-ads',
    customerId,
    since,
    byCampaign: rows,
  }, null, 2));
  console.log(`✅  Wrote Google Ads cache: ${rows.length} rows`);

  if (process.env.DATABASE_URL) {
    const { upsertGoogleAdsDailyByCampaign } = await import('../db.js');
    const inserted = await upsertGoogleAdsDailyByCampaign(rows, { replaceSince: since });
    console.log(`✅  Upserted ${inserted} Google Ads rows into PostgreSQL`);
    return { byCampaign: inserted };
  }
  return { byCampaign: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const since = args.includes('--full') ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  })();

  fetchGoogleAds({ since }).catch(e => {
    console.error('❌  Google Ads fetch failed:', e.message);
    process.exit(1);
  });
}
