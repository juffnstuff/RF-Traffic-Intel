/**
 * lib/audit.js — truth-source reconciliation.
 *
 * Pulls fresh totals LIVE from each upstream API for a finalized window and
 * diffs them against the warehouse tables the dashboard reads. Answers "can
 * I trust these numbers?" with a green/amber/red verdict per metric instead
 * of a manual UI-by-UI reconciliation session.
 *
 * Window: trailing 28 days ending today-4 (past GSC finalization, past
 * GA4 intraday, inside Ads' stable zone). Every check degrades gracefully
 * when its credentials are missing.
 *
 * Expected structural deltas are annotated per check — some sources are
 * SUPPOSED to differ slightly (e.g. warehouse contacts exclude email-less
 * HubSpot records by design).
 */

import 'dotenv/config';

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Verdict thresholds: counts/sums from the same API should tie almost
// exactly; a small drift is a refresh-lag amber; anything bigger is red.
function verdictFor(warehouse, truth, { exactExpected = true } = {}) {
  if (truth == null || warehouse == null) return 'unknown';
  if (Number(truth) === 0 && Number(warehouse) === 0) return 'green';
  if (Number(truth) === 0) return 'red';
  const delta = Math.abs(Number(warehouse) - Number(truth)) / Math.abs(Number(truth));
  if (delta <= (exactExpected ? 0.005 : 0.02)) return 'green';
  if (delta <= 0.05) return 'amber';
  return 'red';
}

function row(source, metric, warehouse, truth, note = '', opts = {}) {
  const w = warehouse == null ? null : Number(warehouse);
  const t = truth == null ? null : Number(truth);
  return {
    source,
    metric,
    warehouse: w,
    truth: t,
    delta_pct: (t != null && w != null && t !== 0) ? ((w - t) / t) * 100 : null,
    verdict: verdictFor(w, t, opts),
    note,
  };
}

function skipped(source, reason) {
  return { source, metric: '(skipped)', warehouse: null, truth: null, delta_pct: null, verdict: 'skipped', note: reason };
}

async function auditGoogleAds(pool, since, until) {
  const need = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET',
                'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'];
  if (need.some(n => !process.env[n]?.trim())) return [skipped('google-ads', 'credentials not configured')];
  const { getAccessToken, adsHeaders, searchStream, num } = await import('../fetchers/_google-ads-api.js');
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '');
  const headers = adsHeaders(await getAccessToken());
  const results = await searchStream(customerId, headers, `
    SELECT metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, segments.date
    FROM customer
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `, 'audit google-ads');
  const truth = results.reduce((a, r) => ({
    cost: a.cost + num(r.metrics?.costMicros) / 1e6,
    clicks: a.clicks + num(r.metrics?.clicks),
    impressions: a.impressions + num(r.metrics?.impressions),
    conversions: a.conversions + num(r.metrics?.conversions),
  }), { cost: 0, clicks: 0, impressions: 0, conversions: 0 });
  const { rows: [w] } = await pool.query(`
    SELECT SUM(cost)::float as cost, SUM(clicks)::int as clicks,
           SUM(impressions)::int as impressions, SUM(conversions)::float as conversions
    FROM google_ads_daily_by_campaign WHERE date BETWEEN $1 AND $2
  `, [since, until]);
  return [
    row('google-ads', 'cost', w.cost, truth.cost.toFixed(2)),
    row('google-ads', 'clicks', w.clicks, truth.clicks),
    row('google-ads', 'impressions', w.impressions, truth.impressions),
    row('google-ads', 'conversions', w.conversions, truth.conversions.toFixed(2),
      'restates for up to 90 days after the click — small drift near the window edge is normal'),
  ];
}

async function auditGa4(pool, since, until) {
  if (!process.env.GA4_PROPERTY_ID?.trim() || !process.env.GOOGLE_CREDENTIALS_JSON?.trim()) {
    return [skipped('ga4', 'credentials not configured')];
  }
  const { BetaAnalyticsDataClient } = await import('@google-analytics/data');
  const client = new BetaAnalyticsDataClient({ credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) });
  const [resp] = await client.runReport({
    property: `properties/${process.env.GA4_PROPERTY_ID.trim()}`,
    dateRanges: [{ startDate: since, endDate: until }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'keyEvents' }],
  });
  const m = resp.rows?.[0]?.metricValues || [];
  const truth = { sessions: Number(m[0]?.value) || 0, users: Number(m[1]?.value) || 0, keyEvents: Number(m[2]?.value) || 0 };
  const { rows: [w] } = await pool.query(`
    SELECT SUM(sessions)::int as sessions, SUM(total_users)::int as users, SUM(conversions)::float as key_events
    FROM ga4_daily WHERE date BETWEEN $1 AND $2
  `, [since, until]);
  return [
    row('ga4', 'sessions', w.sessions, truth.sessions),
    row('ga4', 'users', w.users, truth.users,
      'summing daily users overcounts vs a single-range dedup — expect the warehouse a few % HIGH; that is GA4 math, not a sync bug', { exactExpected: false }),
    row('ga4', 'key events', w.key_events, truth.keyEvents),
  ];
}

async function auditGsc(pool, since, until) {
  if (!process.env.GSC_SITE_URL?.trim() || !process.env.GOOGLE_CREDENTIALS_JSON?.trim()) {
    return [skipped('gsc', 'credentials not configured')];
  }
  const { google } = await import('googleapis');
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.JWT(creds.client_email, null, creds.private_key,
    ['https://www.googleapis.com/auth/webmasters.readonly']);
  const client = google.webmasters({ version: 'v3', auth });
  const res = await client.searchanalytics.query({
    siteUrl: process.env.GSC_SITE_URL.trim(),
    requestBody: { startDate: since, endDate: until, rowLimit: 1 },
  });
  const t = res.data.rows?.[0] || {};
  const { rows: [w] } = await pool.query(`
    SELECT SUM(clicks)::int as clicks, SUM(impressions)::int as impressions
    FROM gsc_daily WHERE date BETWEEN $1 AND $2
  `, [since, until]);
  return [
    row('gsc', 'clicks', w.clicks, t.clicks ?? 0),
    row('gsc', 'impressions', w.impressions, t.impressions ?? 0),
  ];
}

async function auditHubSpot(pool) {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim();
  if (!token) return [skipped('hubspot', 'token not configured')];
  const search = async (body) => {
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, limit: 1, properties: ['email'] }),
    });
    if (!res.ok) throw new Error(`hubspot search HTTP ${res.status}`);
    return (await res.json()).total ?? null;
  };
  const [totalContacts, wonContacts] = await Promise.all([
    search({}),
    search({ filterGroups: [{ filters: [{ propertyName: 'netsuite_quote_status', operator: 'EQ', value: 'Closed Won' }] }] }),
  ]);
  const { rows: [w] } = await pool.query(`
    SELECT COUNT(*)::int as contacts,
           COUNT(*) FILTER (WHERE netsuite_quote_status = 'Closed Won')::int as won_contacts
    FROM hubspot_contacts
  `);
  return [
    row('hubspot', 'contacts', w.contacts, totalContacts,
      'warehouse intentionally excludes email-less contacts — expect the warehouse LOW by that count', { exactExpected: false }),
    row('hubspot', 'contacts with Closed Won quote', w.won_contacts, wonContacts,
      'same email-less exclusion applies', { exactExpected: false }),
  ];
}

async function auditNetSuite(pool, since, until) {
  const need = ['NS_ACCOUNT_ID', 'NS_CONSUMER_KEY', 'NS_CONSUMER_SECRET', 'NS_TOKEN_ID', 'NS_TOKEN_SECRET'];
  if (need.some(n => !process.env[n]?.trim())) return [skipped('netsuite', 'credentials not configured')];
  const { runSuiteQL } = await import('../fetchers/_netsuite-suiteql.js');
  // Mirrors fetch-netsuite's quotes query exactly (recordType + t.total +
  // TRUNC(createddate)) so a mismatch means sync drift, not query drift.
  const rows = await runSuiteQL(`
    SELECT COUNT(*) AS cnt, SUM(t.total) AS total
    FROM transaction t
    WHERE t.recordType = 'estimate'
      AND TRUNC(t.createddate) >= TO_DATE('${since}', 'YYYY-MM-DD')
      AND TRUNC(t.createddate) <= TO_DATE('${until}', 'YYYY-MM-DD')
  `, { label: 'audit quotes' });
  const t = rows[0] || {};
  const { rows: [w] } = await pool.query(`
    SELECT SUM(quotes_count)::int as cnt, SUM(quotes_total)::float as total
    FROM netsuite_daily WHERE date BETWEEN $1 AND $2
  `, [since, until]);
  return [
    row('netsuite', 'quotes created', w.cnt, t.cnt ?? t.CNT),
    row('netsuite', 'quote value', w.total, Number(t.total ?? t.TOTAL ?? 0).toFixed(2),
      'timezone edge days can move a quote ±1 day across the window boundary', { exactExpected: false }),
  ];
}

export async function runDataAudit(pool) {
  const until = isoDaysAgo(4);   // past GSC finalization + GA4 intraday
  const since = isoDaysAgo(31);  // trailing 28-day window
  const sections = await Promise.allSettled([
    auditGoogleAds(pool, since, until),
    auditGa4(pool, since, until),
    auditGsc(pool, since, until),
    auditHubSpot(pool),
    auditNetSuite(pool, since, until),
  ]);
  const names = ['google-ads', 'ga4', 'gsc', 'hubspot', 'netsuite'];
  const results = sections.flatMap((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : [{ source: names[i], metric: '(error)', warehouse: null, truth: null, delta_pct: null,
           verdict: 'error', note: String(s.reason?.message || s.reason).slice(0, 300) }]);
  return { since, until, ran_at: new Date().toISOString(), results };
}
