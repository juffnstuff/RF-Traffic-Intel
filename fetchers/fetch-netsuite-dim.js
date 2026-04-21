/**
 * fetch-netsuite-dim.js
 *
 * Pulls line-level NetSuite data aggregated by (date, part_group, salesrep)
 * so the filtered dashboard page can slice by part group / sales rep.
 *
 * part_group = item.custitem1 (custom list on items)
 * salesrep   = transaction.salesrep (header level)
 *
 * $ totals come from SUM(transactionline.foreignamount) on real item lines
 * (mainline='F', taxline='F'). Transaction counts use COUNT(DISTINCT t.id)
 * so they reflect unique transactions within each (date, part_group, rep) bucket.
 *
 * Emits rows for four trantypes:
 *   quote      — estimates bucketed by TRUNC(t.createddate)
 *   quote_adj  — estimates excl. RF Alternate Solution (custbody_rf_lost_reason != 13)
 *   order      — sales orders bucketed by TRUNC(t.createddate)
 *   shipped    — sales orders bucketed by t.actualShipDate
 */

import 'dotenv/config';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { SIZE_BUCKET_CONFIG } from '../db.js';

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
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
    for (const [k, v] of Object.entries(queryParams)) allParams[k] = String(v);
  }
  const paramString = Object.keys(allParams).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`).join('&');
  const signatureBaseString = [
    method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString),
  ].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = crypto.createHmac('sha256', signingKey).update(signatureBaseString).digest('base64');
  oauthParams.oauth_signature = signature;
  const headerParts = Object.keys(oauthParams).sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(', ');
  return `OAuth realm="${accountId}", ${headerParts}`;
}

// Pagination safety cap — dim queries are wider than the header fetch so the
// default is higher. Throws at the cap instead of silently truncating.
const MAX_ROWS = Number(process.env.NS_DIM_MAX_ROWS) || 500000;

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
  let warned = false;
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
        headers: { Authorization: authHeader, 'Content-Type': 'application/json', Prefer: 'transient' },
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

    if (!warned && hasMore && offset >= MAX_ROWS * 0.8) {
      console.warn(`    ⚠️  approaching dim row cap (${offset}/${MAX_ROWS}) — raise NS_DIM_MAX_ROWS if the result looks truncated`);
      warned = true;
    }
    if (hasMore && offset >= MAX_ROWS) {
      throw new Error(`SuiteQL row cap hit at ${offset} dim rows — raise NS_DIM_MAX_ROWS (currently ${MAX_ROWS}) to fetch the remainder.`);
    }
  }
  return rows;
}

function parseNSDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
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

function buildFilter(sinceDateStr, col) {
  if (!sinceDateStr) return '';
  return `AND ${col} >= TO_DATE('${sinceDateStr}', 'YYYY-MM-DD')`;
}

function lineJoinsAndFilter() {
  // Real item lines only — skip summary/tax rows.
  // Sales rep on the transaction is the `employee` column (title: "Sales Rep"),
  // NOT `salesrep`. Verified via NetSuite SuiteQL metadata catalog.
  return `
    INNER JOIN transactionline tl ON tl.transaction = t.id
    LEFT JOIN item i ON i.id = tl.item
  `;
}

function baseLineConditions() {
  return `
    AND tl.mainline = 'F'
    AND (tl.taxline IS NULL OR tl.taxline = 'F')
    AND tl.item IS NOT NULL
  `;
}

// Bucket each transaction by its own total ($). Buckets agreed from the
// quote-size distribution analysis: 66% under $5K, 26% $5K-$25K, 7% $25K-$100K,
// 1% over $100K. For salesorders / shipped we bucket by the SO's own total
// (quote-to-SO linkage isn't modeled here — this is a macro-level slice).
// Generated from SIZE_BUCKET_CONFIG in db.js so labels + thresholds stay in sync.
const SIZE_BUCKET_CASE = (() => {
  const whens = SIZE_BUCKET_CONFIG
    .filter(b => b.max != null)
    .map(b => `WHEN ABS(COALESCE(t.total, 0)) < ${b.max} THEN '${b.label}'`);
  const last = SIZE_BUCKET_CONFIG.find(b => b.max == null);
  return `CASE\n    ${whens.join('\n    ')}\n    ELSE '${last.label}'\n  END`;
})();

// "Is this the customer's first quote / order?" flags custbody_rf_firstquote
// (estimates) and custbody_rf_firstorder (sales orders + shipped SOs).
// Returns 'Y' or 'N'. Unset / NULL treated as 'N'.
function firstFlagCase(trantype) {
  const field = (trantype === 'quote' || trantype === 'quote_adj')
    ? 'custbody_rf_firstquote'
    : 'custbody_rf_firstorder'; // order + shipped both key off the SO's first-order flag
  return `CASE WHEN t.${field} = 'T' THEN 'Y' ELSE 'N' END`;
}

async function runDimQuery({ recordType, dateCol, extraWhere = '', since, trantype }) {
  const dateFilter = buildFilter(since, dateCol);
  const firstCase = firstFlagCase(trantype);
  // Line amounts on sales-side transactions are stored negative in NetSuite's
  // credit-natural convention; negate so the dashboard shows positive $.
  const sql = `
    SELECT
      ${dateCol} as bucket_date,
      COALESCE(BUILTIN.DF(i.custitem1), '') as part_group,
      COALESCE(TO_CHAR(t.employee), '') as salesrep_id,
      BUILTIN.DF(t.employee) as salesrep_name,
      ${SIZE_BUCKET_CASE} as size_bucket,
      ${firstCase} as is_first,
      COUNT(DISTINCT t.id) as txn_cnt,
      -SUM(tl.foreignamount) as line_total
    FROM transaction t
    ${lineJoinsAndFilter()}
    WHERE t.recordType = '${recordType}'
      ${baseLineConditions()}
      ${extraWhere}
      ${dateFilter}
    GROUP BY ${dateCol}, BUILTIN.DF(i.custitem1), t.employee, BUILTIN.DF(t.employee), ${SIZE_BUCKET_CASE}, ${firstCase}
  `.trim();

  console.log(`  → ${trantype}...`);
  const raw = await runSuiteQL(sql);
  console.log(`    ${raw.length} ${trantype} rows`);

  return raw.map(r => ({
    date: parseNSDate(r.bucket_date ?? r.BUCKET_DATE),
    trantype,
    part_group: r.part_group ?? r.PART_GROUP ?? '',
    salesrep_id: r.salesrep_id ?? r.SALESREP_ID ?? '',
    salesrep_name: r.salesrep_name ?? r.SALESREP_NAME ?? null,
    size_bucket: r.size_bucket ?? r.SIZE_BUCKET ?? 'Under $5K',
    is_first: r.is_first ?? r.IS_FIRST ?? 'N',
    txn_count: Number(r.txn_cnt ?? r.TXN_CNT) || 0,
    line_total: Number(r.line_total ?? r.LINE_TOTAL) || 0,
  })).filter(r => r.date);
}

/**
 * @param {object} opts
 * @param {string|null} opts.since — ISO date string or null for full history
 */
export async function fetchNetSuiteDim({ since = null } = {}) {
  assertIsoDate(since);
  const mode = since ? `incremental (since ${since})` : 'full history';
  console.log(`🔎  NetSuite dim fetch — ${mode}`);

  const quoteRows = await runDimQuery({
    recordType: 'estimate', dateCol: 'TRUNC(t.createddate)',
    since, trantype: 'quote',
  });
  const quoteAdjRows = await runDimQuery({
    recordType: 'estimate', dateCol: 'TRUNC(t.createddate)',
    extraWhere: `AND (t.custbody_rf_lost_reason IS NULL OR t.custbody_rf_lost_reason != 13)`,
    since, trantype: 'quote_adj',
  });
  const orderRows = await runDimQuery({
    recordType: 'salesorder', dateCol: 'TRUNC(t.createddate)',
    since, trantype: 'order',
  });
  const shippedRows = await runDimQuery({
    recordType: 'salesorder', dateCol: 't.actualShipDate',
    extraWhere: `AND t.actualShipDate IS NOT NULL`,
    since, trantype: 'shipped',
  });

  const all = [...quoteRows, ...quoteAdjRows, ...orderRows, ...shippedRows];
  console.log(`  → merged ${all.length} dim rows`);

  if (process.env.DATABASE_URL) {
    const { upsertDailyDimRows } = await import('../db.js');
    const upserted = await upsertDailyDimRows(all, { replaceSince: since });
    console.log(`✅  Upserted ${upserted} dim rows into PostgreSQL`);
  } else {
    console.log('⚠️  DATABASE_URL not set — dim data not persisted');
  }

  return { rows: all.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const since = args.includes('--full') ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  })();

  fetchNetSuiteDim({ since }).catch(e => {
    console.error('❌  Dim fetch failed:', e.message);
    process.exit(1);
  });
}
