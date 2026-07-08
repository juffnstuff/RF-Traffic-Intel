/**
 * _google-ads-api.js — shared Google Ads REST plumbing.
 *
 * Auth + retry helpers used by fetch-google-ads.js (campaign metrics),
 * fetch-google-ads-clicks.js (click_view / gclid lane), and
 * upload-offline-conversions.js. Raw fetch, no SDK dep, same as the
 * original fetcher.
 */

import 'dotenv/config';

export const ADS_API_VERSION = 'v20';

export function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export async function fetchWithRetry(url, init, label) {
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
      // Surface the actual GoogleAdsFailure reason instead of the raw JSON
      // envelope — the envelope truncates before the useful part.
      let reason = '';
      try {
        const parsed = JSON.parse(body);
        const nodes = Array.isArray(parsed) ? parsed : [parsed];
        const msgs = [];
        for (const n of nodes) {
          for (const d of (n.error?.details || [])) {
            for (const e of (d.errors || [])) {
              const code = e.errorCode ? Object.entries(e.errorCode).map(([k, v]) => `${k}=${v}`).join(',') : '';
              msgs.push(`${code}${code && e.message ? ': ' : ''}${e.message || ''}`);
            }
          }
          if (!msgs.length && n.error?.message) msgs.push(n.error.message);
        }
        reason = msgs.slice(0, 3).join(' | ');
      } catch { /* not JSON — fall through to raw slice */ }
      throw new Error(`${label} HTTP ${res.status}: ${reason || body.slice(0, 400)}`);
    }
    const waitMs = Math.min(30000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 500));
    console.log(`    ⏳ ${label} HTTP ${res.status}; retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${MAX_ATTEMPTS})`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

export async function getAccessToken() {
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

/** Standard Ads REST headers (+ optional MCC login-customer-id). */
export function adsHeaders(accessToken) {
  const headers = {
    'Authorization':   `Bearer ${accessToken}`,
    'developer-token': requireEnv('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'Content-Type':    'application/json',
  };
  const loginCustomer = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
  if (loginCustomer) headers['login-customer-id'] = loginCustomer;
  return headers;
}

/** Run a GAQL query via searchStream; returns the flattened results array. */
export async function searchStream(customerId, headers, query, label) {
  const url = `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  }, label);
  const chunks = await res.json();
  const results = [];
  for (const chunk of chunks) {
    for (const row of (chunk.results || [])) results.push(row);
  }
  return results;
}
