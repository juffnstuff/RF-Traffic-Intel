/**
 * fetch-netsuite.js
 *
 * Pulls daily quotes, sales orders, and shipped sales from NetSuite
 * via SuiteQL using OAuth 1.0 Token-Based Authentication.
 *
 * Modes:
 *   - Full: no date filter, fetches ALL historical data (initial backfill)
 *   - Incremental: fetches last N days and upserts into DB
 *
 * Writes to PostgreSQL if DATABASE_URL is set, otherwise falls back to JSON cache.
 */

import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const OUTPUT_PATH = path.join(CACHE_DIR, 'netsuite-daily.json');

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildOAuthHeader({ method, baseUrl, queryParams, accountId, consumerKey, consumerSecret, tokenId, tokenSecret }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: tokenId,
    oauth_version: '1.0',
  };

  const allParams = { ...oauthParams };
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      allParams[k] = String(v);
    }
  }

  const paramString = Object.keys(allParams)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');

  const signatureBaseString = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(paramString),
  ].join('&');

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = crypto.createHmac('sha256', signingKey)
    .update(signatureBaseString)
    .digest('base64');

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return `OAuth realm="${accountId}", ${headerParts}`;
}

async function runSuiteQL(sql) {
  const accountId = requireEnv('NS_ACCOUNT_ID');
  const consumerKey = requireEnv('NS_CONSUMER_KEY');
  const consumerSecret = requireEnv('NS_CONSUMER_SECRET');
  const tokenId = requireEnv('NS_TOKEN_ID');
  const tokenSecret = requireEnv('NS_TOKEN_SECRET');

  const accountSlug = accountId.toLowerCase().replace(/_/g, '-');
  const baseUrl = `https://${accountSlug}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

  const rows = [];
  let offset = 0;
  const limit = 1000;
  let hasMore = true;
  const MAX_ATTEMPTS = 6;

  while (hasMore) {
    const queryParams = { limit: String(limit), offset: String(offset) };
    const fullUrl = `${baseUrl}?limit=${limit}&offset=${offset}`;

    let res;
    for (let attempt = 0; ; attempt++) {
      // Regenerate OAuth header on each attempt — nonce + timestamp must be unique per request.
      const authHeader = buildOAuthHeader({
        method: 'POST', baseUrl, queryParams,
        accountId, consumerKey, consumerSecret, tokenId, tokenSecret,
      });
      res = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Prefer: 'transient',
        },
        body: JSON.stringify({ q: sql }),
      });
      if (res.status !== 429 || attempt >= MAX_ATTEMPTS - 1) break;

      // Respect Retry-After if present, otherwise exponential backoff with jitter.
      const retryAfter = res.headers.get('Retry-After');
      const headerMs = retryAfter && !Number.isNaN(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;
      const waitMs = headerMs ?? Math.min(60000, 2000 * (2 ** attempt) + Math.floor(Math.random() * 1000));
      console.log(`    ⏳ 429 — concurrency limit; backing off ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    if (!res.ok) {
      const text = await res.text();
      console.error(`    ✗ HTTP ${res.status}: ${text.slice(0, 300)}`);
      throw new Error(`SuiteQL error (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    rows.push(...(data.items || []));
    hasMore = data.hasMore === true;
    offset += limit;

    if (offset > 200000) break;
  }

  return rows;
}

function parseNSDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return s;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function assertIsoDate(s) {
  if (s == null) return;
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid 'since' date: expected YYYY-MM-DD, got ${JSON.stringify(s)}`);
  }
}

function redactAccountId(id) {
  if (!id) return '(unset)';
  const s = String(id);
  return s.length <= 4 ? '***' : `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function buildFilter(sinceDateStr, col) {
  if (!sinceDateStr) return '';
  return `AND ${col} >= TO_DATE('${sinceDateStr}', 'YYYY-MM-DD')`;
}

/**
 * @param {object} opts
 * @param {string|null} opts.since  — ISO date string or null for full history
 */
export async function fetchNetSuite({ since = null } = {}) {
  assertIsoDate(since);
  const mode = since ? `incremental (since ${since})` : 'full history';
  console.log(`🔎  NetSuite fetch — ${mode}`);
  console.log(`    Account: ${redactAccountId(process.env.NS_ACCOUNT_ID)}`);

  // Quotes bucketed by estimate creation date
  const quoteCreatedFilter = buildFilter(since, 'TRUNC(t.createddate)');
  // Sales orders bucketed by the date the SO record was created (i.e. when the quote was converted)
  const orderCreatedFilter = buildFilter(since, 'TRUNC(t.createddate)');
  // Shipped by actual ship date
  const shipFilter = buildFilter(since, 't.actualShipDate');

  const quotesQ = `
    SELECT TRUNC(t.createddate) as tranDate, COUNT(*) as cnt, SUM(t.total) as total
    FROM transaction t
    WHERE t.recordType = 'estimate' ${quoteCreatedFilter}
    GROUP BY TRUNC(t.createddate)
  `.trim();

  const ordersQ = `
    SELECT TRUNC(t.createddate) as tranDate, COUNT(*) as cnt, SUM(t.total) as total
    FROM transaction t
    WHERE t.recordType = 'salesorder' ${orderCreatedFilter}
    GROUP BY TRUNC(t.createddate)
  `.trim();

  const shippedQ = `
    SELECT t.actualShipDate as shipDate, COUNT(*) as cnt, SUM(t.total) as total
    FROM transaction t
    WHERE t.recordType = 'salesorder'
      AND t.actualShipDate IS NOT NULL
      ${shipFilter}
    GROUP BY t.actualShipDate
  `.trim();

  // Adjusted quotes: exclude "Lost: Alternate RF Solution/Quote" (custbody_rf_lost_reason = 13)
  const quotesAdjQ = `
    SELECT TRUNC(t.createddate) as tranDate, COUNT(*) as cnt, SUM(t.total) as total
    FROM transaction t
    WHERE t.recordType = 'estimate'
      AND (t.custbody_rf_lost_reason IS NULL OR t.custbody_rf_lost_reason != 13)
      ${quoteCreatedFilter}
    GROUP BY TRUNC(t.createddate)
  `.trim();

  console.log('  → querying estimates...');
  const quotesRaw = await runSuiteQL(quotesQ);
  console.log(`    ${quotesRaw.length} quote-days`);

  console.log('  → querying adjusted estimates (excl. RF Alternate Solution)...');
  const quotesAdjRaw = await runSuiteQL(quotesAdjQ);
  console.log(`    ${quotesAdjRaw.length} adj quote-days`);

  console.log('  → querying sales orders...');
  const ordersRaw = await runSuiteQL(ordersQ);
  console.log(`    ${ordersRaw.length} order-days`);

  console.log('  → querying shipped orders...');
  const shippedRaw = await runSuiteQL(shippedQ);
  console.log(`    ${shippedRaw.length} shipped-days`);

  const byDate = new Map();
  const ensure = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        date,
        quotes_count: 0, quotes_total: 0,
        quotes_adj_count: 0, quotes_adj_total: 0,
        orders_count: 0, orders_total: 0,
        shipped_count: 0, shipped_total: 0,
      });
    }
    return byDate.get(date);
  };

  for (const r of quotesRaw) {
    const date = parseNSDate(r.trandate || r.tranDate);
    if (!date) continue;
    const row = ensure(date);
    row.quotes_count = Number(r.cnt) || 0;
    row.quotes_total = Number(r.total) || 0;
  }

  for (const r of quotesAdjRaw) {
    const date = parseNSDate(r.trandate || r.tranDate);
    if (!date) continue;
    const row = ensure(date);
    row.quotes_adj_count = Number(r.cnt) || 0;
    row.quotes_adj_total = Number(r.total) || 0;
  }

  for (const r of ordersRaw) {
    const date = parseNSDate(r.trandate || r.tranDate);
    if (!date) continue;
    const row = ensure(date);
    row.orders_count = Number(r.cnt) || 0;
    row.orders_total = Number(r.total) || 0;
  }

  for (const r of shippedRaw) {
    const date = parseNSDate(r.shipdate || r.shipDate);
    if (!date) continue;
    const row = ensure(date);
    row.shipped_count = Number(r.cnt) || 0;
    row.shipped_total = Number(r.total) || 0;
  }

  const daily = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  → merged ${daily.length} unique days`);

  // Write to DB if available
  if (process.env.DATABASE_URL) {
    const { upsertDailyRows, logFetch } = await import('../db.js');
    try {
      const upserted = await upsertDailyRows(daily);
      await logFetch('success', upserted, null);
      console.log(`✅  Upserted ${upserted} rows into PostgreSQL`);
    } catch (e) {
      await logFetch('error', 0, e.message).catch(() => {});
      throw e;
    }
  }

  // Always write JSON cache as fallback
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const out = {
    generated: new Date().toISOString(),
    source: 'netsuite-suiteql',
    sources: ['netsuite'],
    accountId: process.env.NS_ACCOUNT_ID,
    daily,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`✅  Wrote ${daily.length} daily rows to JSON cache`);

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const since = args.includes('--full') ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  })();

  fetchNetSuite({ since }).catch(e => {
    console.error('❌  Fetch failed:', e.message);
    process.exit(1);
  });
}
