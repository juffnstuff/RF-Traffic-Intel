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
    const queryParams = { limit: String(limit), offset: String(offset) };
    const fullUrl = `${baseUrl}?limit=${limit}&offset=${offset}`;
    const authHeader = buildOAuthHeader({
      method: 'POST', baseUrl, queryParams,
      accountId, consumerKey, consumerSecret, tokenId, tokenSecret,
    });
    const res = await fetch(fullUrl, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json', Prefer: 'transient' },
      body: JSON.stringify({ q: sql }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`    ✗ HTTP ${res.status}: ${text.slice(0, 300)}`);
      throw new Error(`SuiteQL error (${res.status}): ${text.slice(0, 500)}`);
    }
    const data = await res.json();
    rows.push(...(data.items || []));
    hasMore = data.hasMore === true;
    offset += limit;
    if (offset > 500000) break;
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

function buildFilter(sinceDateStr, col) {
  if (!sinceDateStr) return '';
  return `AND ${col} >= TO_DATE('${sinceDateStr}', 'YYYY-MM-DD')`;
}

function lineJoinsAndFilter() {
  // real item lines only — skip summary/tax rows
  // `mls` = main transaction line (mainline='T'); carries header-level
  // salesrep since SuiteQL doesn't expose transaction.salesrep directly.
  return `
    INNER JOIN transactionline tl ON tl.transaction = t.id
    INNER JOIN transactionline mls ON mls.transaction = t.id AND mls.mainline = 'T'
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

async function runDimQuery({ recordType, dateCol, extraWhere = '', since, trantype }) {
  const dateFilter = buildFilter(since, dateCol);
  const sql = `
    SELECT
      ${dateCol} as bucket_date,
      COALESCE(BUILTIN.DF(i.custitem1), '') as part_group,
      COALESCE(TO_CHAR(mls.salesrep), '') as salesrep_id,
      BUILTIN.DF(mls.salesrep) as salesrep_name,
      COUNT(DISTINCT t.id) as txn_cnt,
      SUM(tl.foreignamount) as line_total
    FROM transaction t
    ${lineJoinsAndFilter()}
    WHERE t.recordType = '${recordType}'
      ${baseLineConditions()}
      ${extraWhere}
      ${dateFilter}
    GROUP BY ${dateCol}, BUILTIN.DF(i.custitem1), mls.salesrep, BUILTIN.DF(mls.salesrep)
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
    txn_count: Number(r.txn_cnt ?? r.TXN_CNT) || 0,
    line_total: Number(r.line_total ?? r.LINE_TOTAL) || 0,
  })).filter(r => r.date);
}

/**
 * @param {object} opts
 * @param {string|null} opts.since — ISO date string or null for full history
 */
export async function fetchNetSuiteDim({ since = null } = {}) {
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
