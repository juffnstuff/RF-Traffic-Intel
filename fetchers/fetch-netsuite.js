/**
 * fetch-netsuite.js
 *
 * Pulls daily quotes, sales orders, and shipped sales from NetSuite
 * via SuiteQL using OAuth 1.0 Token-Based Authentication.
 *
 * Requires env vars:
 *   NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET,
 *   NS_TOKEN_ID, NS_TOKEN_SECRET
 *
 * Outputs:
 *   data/cache/netsuite-daily.json
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

const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '540', 10);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function buildOAuthHeader({ method, url, accountId, consumerKey, consumerSecret, tokenId, tokenSecret }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_token: tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join('&');

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;

  const headerParams = Object.keys(oauthParams)
    .sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return `OAuth realm="${accountId}", ${headerParams}`;
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

  while (hasMore) {
    const url = `${baseUrl}?limit=${limit}&offset=${offset}`;
    const authHeader = buildOAuthHeader({
      method: 'POST',
      url: baseUrl,
      accountId, consumerKey, consumerSecret, tokenId, tokenSecret,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Prefer: 'transient',
      },
      body: JSON.stringify({ q: sql }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SuiteQL error (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    rows.push(...(data.items || []));
    hasMore = data.hasMore === true;
    offset += limit;

    if (offset > 50000) break;
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

export async function fetchNetSuite() {
  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  const sinceStr = since.toISOString().slice(0, 10);

  console.log(`🔎  NetSuite fetch — lookback ${LOOKBACK_DAYS} days (since ${sinceStr})`);

  const quotesQ = `
    SELECT t.tranDate, COUNT(*) as cnt, SUM(t.total) as total
    FROM transaction t
    WHERE t.recordType = 'estimate' AND t.tranDate >= TO_DATE('${sinceStr}', 'YYYY-MM-DD')
    GROUP BY t.tranDate
  `.trim();

  const ordersQ = `
    SELECT t.tranDate, COUNT(*) as cnt, SUM(t.total) as total
    FROM transaction t
    WHERE t.recordType = 'salesorder' AND t.tranDate >= TO_DATE('${sinceStr}', 'YYYY-MM-DD')
    GROUP BY t.tranDate
  `.trim();

  const shippedQ = `
    SELECT t.actualShipDate as shipDate, COUNT(*) as cnt, SUM(t.total) as total
    FROM transaction t
    WHERE t.recordType = 'salesorder'
      AND t.actualShipDate IS NOT NULL
      AND t.actualShipDate >= TO_DATE('${sinceStr}', 'YYYY-MM-DD')
    GROUP BY t.actualShipDate
  `.trim();

  console.log('  → querying estimates...');
  const quotesRaw = await runSuiteQL(quotesQ);
  console.log(`    ${quotesRaw.length} quote-days`);

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

  const out = {
    generated: new Date().toISOString(),
    source: 'netsuite-suiteql',
    accountId: process.env.NS_ACCOUNT_ID,
    lookbackDays: LOOKBACK_DAYS,
    daily,
  };

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`✅  Wrote ${daily.length} daily rows to ${OUTPUT_PATH}`);

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchNetSuite().catch(e => {
    console.error('❌  Fetch failed:', e.message);
    process.exit(1);
  });
}
